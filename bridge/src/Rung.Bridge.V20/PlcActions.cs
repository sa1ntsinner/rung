// SPDX-License-Identifier: BUSL-1.1
// Online, download, connection listing and "show in TIA Portal" (docs/downloads.md).
// The answers to TIA's download questions come from DownloadPolicy.
using System;
using System.Collections.Generic;
using System.Linq;
using System.Security;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;
using Siemens.Engineering.Compare;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.Connection;
using Siemens.Engineering.Download;
using Siemens.Engineering.Download.Configurations;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.Online;
using Siemens.Engineering.Upload;
using Siemens.Engineering.Upload.Configurations;

namespace Rung.Bridge.V20
{
    public sealed partial class OpennessSession
    {
        /// <summary>The CPU device item that carries the PLC software (the online and download providers live there).</summary>
        DeviceItem CpuItem(string device)
        {
            var plc = Plc(device);
            var item = (plc.Parent as SoftwareContainer)?.Parent as DeviceItem;
            if (item == null) throw new RpcException(ErrorCodes.UnsupportedObject, "Cannot find the CPU of " + device);
            return item;
        }

        /// <summary>The station (device) compiles hardware and software together.</summary>
        ICompilable StationCompiler(string device)
        {
            var item = CpuItem(device);
            var target = (IEngineeringServiceProvider)StationOf(item) ?? item;
            return target.GetService<ICompilable>() ?? item.GetService<ICompilable>()
                ?? throw new RpcException(ErrorCodes.UnsupportedCapability, device + " cannot be compiled as hardware");
        }

        public IReadOnlyList<CompileMessage> CompileHardware(string device)
        {
            Alive();
            Listen();
            var compiler = StationCompiler(device);
            var messages = new List<CompileMessage>();
            using (OfflineFor(device))
            {
                try { Flatten(compiler.Compile().Messages, null, new Dictionary<string, string>(), messages); }
                catch (EngineeringException e) { throw new RpcException(ErrorCodes.Internal, "compile failed: " + e.Message); }
            }
            return messages;
        }

        public OnlineStatus Online(string device, string action, ConnectionTarget target)
        {
            Alive();
            Listen();
            var provider = CpuItem(device).GetService<OnlineProvider>();
            if (provider == null) throw new RpcException(ErrorCodes.UnsupportedCapability, device + " has no online access");
            string reached = null;
            try
            {
                switch (action)
                {
                    case "state":
                        break;
                    case "online":
                        if (provider.State == OnlineState.Online) break;
                        // NotReachable, Connecting and friends still count as online mode for Openness: leave it first
                        GoOfflineQuietly(provider);
                        if (target != null && !string.IsNullOrEmpty(target.Mode))
                            provider.Configuration.ApplyConfiguration(ResolveTarget(provider.Configuration, target, device));
                        else if (!provider.Configuration.IsConfigured)
                            throw new RpcException(ErrorCodes.NoTarget, NoTargetMessage(device));
                        try { provider.GoOnline(); }
                        catch (EngineeringException)
                        {
                            GoOfflineQuietly(provider);
                            throw;
                        }
                        // a half-open connection (not reachable, wrong device) would block compile and download
                        if (provider.State != OnlineState.Online)
                        {
                            reached = provider.State.ToString();
                            GoOfflineQuietly(provider);
                        }
                        break;
                    case "offline":
                        provider.GoOffline();
                        break;
                    default:
                        throw new RpcException(ErrorCodes.BadRequest, "action must be state, online or offline");
                }
            }
            catch (EngineeringException e) { throw new RpcException(ErrorCodes.OnlineFailed, e.Message); }
            return new OnlineStatus { Device = device, State = reached ?? provider.State.ToString() };
        }

        void LeaveOnline(string device)
        {
            try { var p = CpuItem(device).GetService<OnlineProvider>(); if (p != null) GoOfflineQuietly(p); }
            catch (RpcException) { }
            catch (EngineeringException) { }
        }

        static void GoOfflineQuietly(OnlineProvider provider)
        {
            if (provider.State == OnlineState.Offline) return;
            try { provider.GoOffline(); } catch (EngineeringException) { }
        }

        /// <summary>
        /// Openness refuses compile, import and download while TIA Portal is in online mode with the CPU (the
        /// TIA Portal window allows them). The scope leaves online mode and goes back online when disposed.
        /// </summary>
        IDisposable OfflineFor(string device)
        {
            OnlineProvider provider = null;
            try { provider = CpuItem(device).GetService<OnlineProvider>(); }
            catch (RpcException) { }
            catch (EngineeringException) { }
            return new OfflineScope(provider);
        }

        sealed class OfflineScope : IDisposable
        {
            readonly OnlineProvider _provider;
            readonly bool _restore;

            public OfflineScope(OnlineProvider provider)
            {
                _provider = provider;
                if (provider == null || provider.State == OnlineState.Offline) return;
                _restore = provider.State == OnlineState.Online;
                GoOfflineQuietly(provider);
            }

            public void Dispose()
            {
                if (!_restore) return;
                try { _provider.GoOnline(); } catch (EngineeringException) { }
            }
        }

        public CompareOutcome Compare(string device, ConnectionTarget target)
        {
            Alive();
            Listen();
            var plc = Plc(device);
            var provider = CpuItem(device).GetService<OnlineProvider>();
            if (provider == null) throw new RpcException(ErrorCodes.UnsupportedCapability, device + " has no online access");
            var byName = AddressesByName(device);
            var wentOnline = false;
            try
            {
                // CompareToOnline needs online mode; go online for it and leave again when rung went online itself
                if (provider.State != OnlineState.Online)
                {
                    GoOfflineQuietly(provider);
                    if (target != null && !string.IsNullOrEmpty(target.Mode))
                        provider.Configuration.ApplyConfiguration(ResolveTarget(provider.Configuration, target, device));
                    else if (!provider.Configuration.IsConfigured)
                        throw new RpcException(ErrorCodes.NoTarget, NoTargetMessage(device));
                    wentOnline = true;
                    provider.GoOnline();
                    if (provider.State != OnlineState.Online)
                        throw new RpcException(ErrorCodes.OnlineFailed, device + " is " + provider.State + "; the comparison needs an online connection");
                }
                var result = plc.CompareToOnline();
                // TIA fills the result lazily over the online connection: read all of it before going offline,
                // afterwards every PLC-side object reads as "Does not exist"
                var outcome = new CompareOutcome { Device = device, State = result.RootElement.ComparisonResult.ToString() };
                Walk(result.RootElement, "", byName, outcome);
                return outcome;
            }
            catch (EngineeringException e) { throw new RpcException(ErrorCodes.OnlineFailed, e.Message); }
            finally { if (wentOnline) GoOfflineQuietly(provider); }
        }

        static void Walk(CompareResultElement parent, string path, Dictionary<string, string> byName, CompareOutcome into)
        {
            foreach (CompareResultElement e in parent.Elements)
            {
                var state = e.ComparisonResult.ToString();
                var name = (state == "LeftMissing" ? e.RightName : e.LeftName) ?? "";
                var here = path.Length == 0 ? name : path + "/" + name;
                var kind = CompareItem.Kind(state);
                if (kind != null)
                {
                    byName.TryGetValue(CompareItem.ObjectName(name), out var address);
                    into.Items.Add(new CompareItem { Path = here, Name = name, State = kind, Detail = string.IsNullOrEmpty(e.DetailedInformation) ? null : e.DetailedInformation, Address = address });
                    continue; // the details below a differing object are TIA's, not separate objects
                }
                if (state == "ObjectsIdentical") { into.Identical++; continue; }
                Walk(e, here, byName, into);
            }
        }

        public ConnectionOptions Connections(string device, bool scan)
        {
            Alive();
            var item = CpuItem(device);
            var cfg = (item.GetService<DownloadProvider>()?.Configuration) ?? item.GetService<OnlineProvider>()?.Configuration;
            if (cfg == null) throw new RpcException(ErrorCodes.UnsupportedCapability, device + " has no connection configuration");
            var result = new ConnectionOptions { Device = device, Configured = cfg.IsConfigured, PlcAddresses = PlcAddresses(item) };
            foreach (ConfigurationMode mode in cfg.Modes)
            {
                var m = new ConnectionModeInfo { Name = mode.Name };
                foreach (ConfigurationPcInterface pc in mode.PcInterfaces)
                {
                    var info = new PcInterfaceInfo
                    {
                        Name = pc.Name,
                        Number = pc.Number,
                        TargetInterfaces = pc.TargetInterfaces.Select(t => t.Name).ToArray(),
                        Subnets = pc.Subnets.Select(s => s.Name).ToArray(),
                    };
                    if (scan)
                    {
                        info.Accessible = new List<AccessibleDeviceInfo>();
                        try
                        {
                            foreach (var d in pc.GetAccessibleDevices())
                                info.Accessible.Add(new AccessibleDeviceInfo { Name = d.Name, Address = d.Address, DeviceSeries = d.DeviceSeries, MacAddress = d.MACAddress });
                        }
                        catch (EngineeringException) { /* interface not usable right now (cable, driver): report it without devices */ }
                    }
                    m.PcInterfaces.Add(info);
                }
                result.Modes.Add(m);
            }
            return result;
        }

        public DownloadOutcome Download(DownloadRequest request)
        {
            if (!_args.AllowDownload)
                throw new RpcException(ErrorCodes.DownloadDisabled, "This bridge was not started for downloads: only rung download starts one that may download (--allow-download). Nothing was downloaded.");
            Listen();
            Alive();
            var item = CpuItem(request.Device);
            var provider = item.GetService<DownloadProvider>();
            if (provider == null) throw new RpcException(ErrorCodes.UnsupportedCapability, request.Device + " cannot be downloaded");
            if (request.Target == null || string.IsNullOrEmpty(request.Target.Mode))
                throw new RpcException(ErrorCodes.NoTarget, NoTargetMessage(request.Device));
            var target = ResolveTarget(provider.Configuration, request.Target, request.Device);

            var options = DownloadOptions.None;
            if (request.Hardware) options |= DownloadOptions.Hardware;
            if (request.Software) options |= request.OnlyChanges ? DownloadOptions.SoftwareOnlyChanges : DownloadOptions.Software;
            if (options == DownloadOptions.None) throw new RpcException(ErrorCodes.BadRequest, "Nothing to download: choose hardware and/or software");

            var outcome = new DownloadOutcome { Device = request.Device };
            DownloadConfigurationDelegate pre = c => Answer(c, "pre", request, outcome);
            DownloadConfigurationDelegate post = c => Answer(c, "post", request, outcome);
            using (OfflineFor(request.Device))
            try
            {
                var result = provider.Download(target, pre, post, options);
                outcome.Errors = result.ErrorCount;
                outcome.Warnings = result.WarningCount;
                Collect(result.Messages, outcome.Messages);
                outcome.State = outcome.Decisions.Any(d => d.Blocks) ? "Cancelled" : result.State.ToString();
            }
            catch (EngineeringException e)
            {
                outcome.Messages.Add(TiaText.Clean(e.Message));
                outcome.State = outcome.Decisions.Any(d => d.Blocks) ? "Cancelled" : "Error";
            }
            outcome.NeedsAllow = outcome.Decisions.Where(d => d.Blocks).Select(d => d.Name).Distinct().ToArray();
            return outcome;
        }

        public void Show(string address)
        {
            Alive();
            var r = Resolve(address);
            var m = r.Obj.GetType().GetMethod("ShowInEditor", Type.EmptyTypes);
            if (m == null) throw new RpcException(ErrorCodes.UnsupportedObject, address + " has no editor");
            try { m.Invoke(r.Obj, null); }
            catch (System.Reflection.TargetInvocationException e) when (e.InnerException is EngineeringException)
            {
                throw new RpcException(ErrorCodes.UnsupportedCapability, "TIA Portal cannot show it (a TIA Portal started without user interface has no editors): " + e.InnerException.Message);
            }
        }

        // ------------------------------------------------------------------ helpers

        /// <summary>Never throws: an exception escaping the delegate makes TIA fail the download without saying why.</summary>
        static void Answer(DownloadConfiguration c, string phase, DownloadRequest request, DownloadOutcome outcome)
        {
            try { AnswerCore(c, phase, request, outcome); }
            catch (Exception e)
            {
                var inner = e is System.Reflection.TargetInvocationException t && t.InnerException != null ? t.InnerException : e;
                string message = null;
                try { message = c.Message; } catch (Exception) { }
                outcome.Decisions.Add(new DownloadDecision
                {
                    Phase = phase, Kind = c.GetType().Name, Name = DownloadPolicy.NameOf(c.GetType().Name), Choice = "unanswered", Blocks = true,
                    Message = (message ?? "") + " (rung could not answer: " + inner.Message.Split('\n')[0].Trim() + ")",
                });
            }
        }

        /// <summary>
        /// TIA Portal's "Upload device as new station": reads hardware and software of the PLC at an address into a
        /// new station of this project and saves. The PLC is only read. S7-PLCSIM cannot be uploaded (TIA Portal:
        /// "Substitute Object … cannot be uploaded from the device").
        /// </summary>
        public UploadOutcome UploadStation(UploadRequest request)
        {
            Alive();
            Listen();
            // the project gains a station: a project change like an import
            FixtureGuard.CheckImport(_args.AllowImport, _args.AllowFixtureImport, _project.Path.FullName);
            var provider = _project.GetService<StationUploadProvider>() ?? throw new RpcException(ErrorCodes.UnsupportedCapability, "This TIA Portal offers no station upload");
            var cfg = provider.Configuration;
            var mode = cfg.Modes.Find(string.IsNullOrEmpty(request.Mode) ? "PN/IE" : request.Mode)
                ?? throw new RpcException(ErrorCodes.NoTarget, "No connection mode \"" + request.Mode + "\" (" + string.Join(", ", cfg.Modes.Select(m => m.Name)) + ")");
            var all = mode.PcInterfaces.ToList();
            var names = string.Join(", ", all.Select(i => i.Name + (i.Number > 1 ? " (" + i.Number + ")" : "")));
            ConfigurationPcInterface pc;
            if (!string.IsNullOrEmpty(request.PcInterface))
                pc = mode.PcInterfaces.Find(request.PcInterface, request.PcInterfaceNumber <= 0 ? 1 : request.PcInterfaceNumber)
                    ?? throw new RpcException(ErrorCodes.NoTarget, "No PG/PC interface \"" + request.PcInterface + "\" in " + mode.Name + " (" + names + ")");
            else if (all.Count == 1) pc = all[0];
            else throw new RpcException(ErrorCodes.NoTarget, (all.Count == 0 ? "No PG/PC interface in " + mode.Name : "Several PG/PC interfaces (" + names + "): pass --pc-interface <name>"));

            var outcome = new UploadOutcome();
            var needsPassword = false;
            UploadResult result;
            using (var guard = new PasswordPromptGuard(_tiaPid))
            {
                try
                {
                    var address = pc.Addresses.Create(request.Address);
                    result = provider.StationUpload(address, c =>
                    {
                        if (c is UploadMissingProducts missing) missing.CurrentSelection = UploadMissingProductsSelections.TryUpload;
                        else if (c is UploadPasswordConfiguration pw)
                        {
                            var secret = Environment.GetEnvironmentVariable("RUNG_PLC_PASSWORD");
                            if (string.IsNullOrEmpty(secret)) { needsPassword = true; return; }
                            var s = new SecureString();
                            foreach (var ch in secret) s.AppendChar(ch);
                            pw.SetPassword(s);
                        }
                        outcome.Messages.Add(c.Message);
                    });
                }
                catch (EngineeringException e)
                {
                    throw new RpcException(ErrorCodes.OnlineFailed, "Upload from " + request.Address + " failed: " + Sentence(TiaReason(e))
                        + (needsPassword ? " The PLC asks for a password to read it: set RUNG_PLC_PASSWORD." : "")
                        + (string.Equals(pc.Name, "PLCSIM", StringComparison.OrdinalIgnoreCase) ? " S7-PLCSIM cannot be uploaded as a station; upload from a real PLC." : ""));
                }
            }
            outcome.State = result.State.ToString();
            void Flatten(UploadResultMessageComposition list)
            {
                foreach (UploadResultMessage m in list)
                {
                    if (!string.IsNullOrEmpty(m.Message)) outcome.Messages.Add(m.Message);
                    Flatten(m.Messages);
                }
            }
            Flatten(result.Messages);
            var station = result.UploadedStation;
            if (station != null)
            {
                outcome.Station = station.Name;
                outcome.Plcs = SoftwareOf(station.DeviceItems).OfType<Siemens.Engineering.SW.PlcSoftware>().Select(p => p.Name).ToArray();
                try { _project.Save(); }
                catch (EngineeringException e)
                {
                    outcome.SaveError = e.Message.Trim();
                    // not kept half: the station comes out again, so a later save (or TIA's own) keeps no station
                    // rung reported as failed, and uploading again adds no second one
                    try { station.Delete(); outcome.StationRemoved = true; }
                    catch (EngineeringException) { }
                }
            }
            _index.Clear();
            return outcome;
        }

        static void AnswerCore(DownloadConfiguration c, string phase, DownloadRequest request, DownloadOutcome outcome)
        {
            var kind = c.GetType().Name;
            var d = new DownloadDecision { Phase = phase, Kind = kind, Message = c.Message };
            if (c is DownloadPasswordConfiguration pw)
            {
                var secret = Environment.GetEnvironmentVariable("RUNG_PLC_PASSWORD");
                d.Name = "password";
                if (!string.IsNullOrEmpty(secret))
                {
                    var s = new SecureString();
                    foreach (var ch in secret) s.AppendChar(ch);
                    pw.SetPassword(s);
                    d.Choice = "password";
                    d.Allowed = true;
                }
                else
                {
                    d.Choice = "none";
                    d.Blocks = true;
                    d.Message = (d.Message ?? "") + " (set RUNG_PLC_PASSWORD)";
                }
            }
            else if (c is DownloadCheckConfiguration check)
            {
                var dec = DownloadPolicy.DecideCheck(kind, request.Allow);
                check.Checked = dec.Checked;
                d.Name = dec.Name; d.Choice = dec.Choice; d.Allowed = dec.Allowed; d.Blocks = dec.Blocks;
            }
            else
            {
                var prop = c.GetType().GetProperty("CurrentSelection");
                if (prop != null && prop.PropertyType.IsEnum && prop.CanWrite)
                {
                    var dec = DownloadPolicy.Decide(kind, Enum.GetNames(prop.PropertyType), request.Allow, request.StartAfter);
                    d.Name = dec.Name; d.Choice = dec.Choice; d.Allowed = dec.Allowed; d.Blocks = dec.Blocks;
                    try { prop.SetValue(c, Enum.Parse(prop.PropertyType, dec.Choice)); }
                    catch (System.Reflection.TargetInvocationException) when (dec.Blocks)
                    {
                        // TIA accepts no "don't" here (DataBlockReinitialization only takes StopPlcAndReinitialize);
                        // leaving the question unanswered cancels the download, which is what rung wants
                        d.Choice = "unanswered";
                    }
                }
                else
                {
                    // informational entries (no answer to give)
                    d.Name = DownloadPolicy.Kebab(kind);
                    d.Choice = "info";
                    d.Allowed = true;
                }
            }
            outcome.Decisions.Add(d);
        }

        static void Collect(DownloadResultMessageComposition list, List<string> into)
        {
            foreach (DownloadResultMessage m in list)
            {
                if (!string.IsNullOrEmpty(m.Message)) into.Add(m.State + ": " + m.Message);
                Collect(m.Messages, into);
            }
        }

        static ConfigurationTargetInterface ResolveTarget(ConnectionConfiguration cfg, ConnectionTarget t, string device)
        {
            // an S7-PLCSIM instance has no PLC certificate, so the secure PG/PC channel TIA V20 uses by default fails
            // with "Connect to module failed"; TIA Portal's own "Start simulation" talks to it the legacy way
            if (string.Equals(t.PcInterface, "PLCSIM", StringComparison.OrdinalIgnoreCase) && !cfg.EnableLegacyCommunication)
                cfg.EnableLegacyCommunication = true;
            var mode = cfg.Modes.Find(t.Mode) ?? throw new RpcException(ErrorCodes.NoTarget, "No connection mode \"" + t.Mode + "\" for " + device + "; run rung interfaces");
            var pc = mode.PcInterfaces.Find(t.PcInterface, t.PcInterfaceNumber <= 0 ? 1 : t.PcInterfaceNumber)
                ?? throw new RpcException(ErrorCodes.NoTarget, "No PG/PC interface \"" + t.PcInterface + "\" (" + t.PcInterfaceNumber + ") in mode " + t.Mode + "; run rung interfaces");
            if (!string.IsNullOrEmpty(t.TargetInterface))
                return pc.TargetInterfaces.Find(t.TargetInterface) ?? throw new RpcException(ErrorCodes.NoTarget, "No target interface \"" + t.TargetInterface + "\" on " + t.PcInterface + "; run rung interfaces");
            var all = pc.TargetInterfaces.ToList();
            if (all.Count == 1) return all[0];
            throw new RpcException(ErrorCodes.NoTarget, (all.Count == 0 ? "No target interface" : "Several target interfaces (" + string.Join(", ", all.Select(a => a.Name)) + ")") + " on " + t.PcInterface + "; set target_interface in rung.toml");
        }

        /// <summary>IP addresses configured for the interfaces of the CPU's station.</summary>
        static List<PlcAddressInfo> PlcAddresses(DeviceItem cpu)
        {
            var result = new List<PlcAddressInfo>();
            void Walk(DeviceItemComposition items)
            {
                foreach (DeviceItem it in items)
                {
                    var ni = it.GetService<NetworkInterface>();
                    if (ni != null)
                        foreach (Node n in ni.Nodes)
                        {
                            string address = null;
                            try { address = n.GetAttribute("Address") as string; } catch (EngineeringException) { }
                            if (!string.IsNullOrEmpty(address)) result.Add(new PlcAddressInfo { Interface = it.Name, Address = address, Subnet = n.ConnectedSubnet?.Name });
                        }
                    Walk(it.DeviceItems);
                }
            }
            try { Walk(cpu.DeviceItems); } catch (EngineeringException) { }
            return result;
        }

        static string NoTargetMessage(string device) =>
            "No connection configured for " + device + ": run rung interfaces, then set mode, pc_interface and target_interface under [plc." + device + "] in rung.toml";
    }
}
