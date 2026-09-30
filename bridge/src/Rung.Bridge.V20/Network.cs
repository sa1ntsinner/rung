// SPDX-License-Identifier: BUSL-1.1
// plc/<PLC>/hardware/network.yaml (format: Rung.Bridge.Core.NetworkYaml): the Ethernet interfaces of the PLC's
// station and of the IO devices on its IO systems, read from and written to their Openness nodes.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;

namespace Rung.Bridge.V20
{
    public sealed partial class OpennessSession
    {
        const string NetworkLeaf = "network";

        sealed class NetNode
        {
            public string Key;
            public Node Node;
        }

        static DeviceItem CpuItemOf(PlcSoftware plc) => (plc.Parent as SoftwareContainer)?.Parent as DeviceItem;

        static Device StationOf(IEngineeringObject item)
        {
            for (var o = item; o != null; o = o.Parent)
                if (o is Device d) return d;
            return null;
        }

        /// <summary>The Ethernet nodes of the CPU's station, then those of the IO devices on its IO systems.</summary>
        static List<NetNode> NetworkNodes(DeviceItem cpu)
        {
            var station = StationOf(cpu);
            var found = new List<(DeviceItem Item, NetworkInterface Ni)>();
            void Walk(DeviceItemComposition items)
            {
                foreach (DeviceItem i in items)
                {
                    var ni = i.GetService<NetworkInterface>();
                    if (ni != null) found.Add((i, ni));
                    Walk(i.DeviceItems);
                }
            }
            if (station != null) Walk(station.DeviceItems);
            foreach (var (_, ni) in found.ToList())
                foreach (IoController c in ni.IoControllers)
                {
                    var system = c.IoSystem;
                    if (system == null) continue;
                    foreach (IoConnector con in system.ConnectedIoDevices)
                        if (con.Parent is NetworkInterface dni && dni.Parent is DeviceItem item && !found.Any(f => f.Item.Equals(item)))
                            found.Add((item, dni));
                }
            var nodes = new List<(string Module, string Station, string Leaf, Node Node)>();
            foreach (var (item, ni) in found)
            {
                var ethernet = ni.Nodes.Cast<Node>().Where(n => n.NodeType.ToString() == "Ethernet").ToList();
                foreach (var n in ethernet)
                    nodes.Add(((item.Parent as DeviceItem)?.Name ?? StationOf(item)?.Name ?? "", StationOf(item)?.Name ?? "", item.Name + (ethernet.Count > 1 ? " / " + n.Name : ""), n));
            }
            // module names are unique in practice; where two are not, the station tells them apart
            var clash = new HashSet<string>(nodes.GroupBy(n => n.Module + " / " + n.Leaf, StringComparer.Ordinal).Where(g => g.Count() > 1).Select(g => g.Key), StringComparer.Ordinal);
            return nodes.Select(n =>
            {
                var key = n.Module + " / " + n.Leaf;
                return new NetNode { Key = clash.Contains(key) ? n.Station + " / " + key : key, Node = n.Node };
            }).ToList();
        }

        static object Attr(IEngineeringObject o, string name)
        {
            try { return o.GetAttribute(name); } catch (EngineeringException) { return null; }
        }

        static InterfaceSettings ReadSettings(NetNode n)
        {
            var s = new InterfaceSettings { Key = n.Key };
            var node = n.Node;
            var sel = Attr(node, "IpProtocolSelection")?.ToString();
            switch (sel)
            {
                case null: break;
                case "Project":
                    s.Ip = Attr(node, "Address") as string;
                    s.SubnetMask = Attr(node, "SubnetMask") as string;
                    if (Attr(node, "UseRouter") is bool router) s.Router = router ? Attr(node, "RouterAddress") as string ?? NetworkYaml.None : NetworkYaml.None;
                    break;
                case "Dhcp": s.Ip = "dhcp"; break;
                case "OtherPath": s.Ip = "other"; break;
                default: s.Ip = char.ToLowerInvariant(sel[0]) + sel.Substring(1); break; // chosen in TIA Portal, e.g. viaIoController
            }
            if (Attr(node, "PnDeviceNameAutoGeneration") is bool auto)
            {
                var name = Attr(node, "PnDeviceName") as string;
                s.DeviceName = auto ? NetworkYaml.Auto : name;
                if (auto) s.GeneratedName = name;
            }
            return s;
        }

        static string NetworkText(string device, IEnumerable<NetNode> nodes) => NetworkYaml.Render(device, nodes.Select(ReadSettings));

        static string ContentHash(string text) => "xh:" + Bundle.Sha256(new UTF8Encoding(false).GetBytes(text)).Substring(0, 16);

        void WalkNetwork(PlcSoftware plc, string device, List<ObjectRef> refs)
        {
            var cpu = CpuItemOf(plc);
            if (cpu == null) return;
            var nodes = NetworkNodes(cpu);
            if (nodes.Count == 0) return;
            refs.Add(new ObjectRef
            {
                Entry = new ObjectEntry { Address = Addr(device, "hardware", new List<string>(), NetworkLeaf, null), Kind = "hardware", Fingerprint = ContentHash(NetworkText(device, nodes)) },
                Obj = cpu,
                Plc = plc,
            });
        }

        string NetworkRevision(ObjectRef r) => ContentHash(NetworkText(AddressFormat.Parse(r.Entry.Address).Device, NetworkNodes((DeviceItem)r.Obj)));

        ExportResult ImportNetwork(ObjectRef r, string path, string expectedTiaRevision, string operationId)
        {
            var address = r.Entry.Address;
            var device = AddressFormat.Parse(address).Device;
            List<InterfaceSettings> want;
            try { want = NetworkYaml.Parse(File.ReadAllText(path)); }
            catch (NetworkFormatException e) { throw new RpcException(ErrorCodes.ImportFailed, e.Message + ". Nothing was changed"); }
            Dictionary<string, InterfaceSettings> before = null;
            var attempted = false;
            _inImport = true;
            try
            {
                using (var access = _portal.ExclusiveAccess("rung: network settings of " + device))
                {
                    // read and compare under exclusive access, so the settings changed are the ones checked
                    var nodes = NetworkNodes((DeviceItem)r.Obj);
                    var byKey = nodes.ToDictionary(n => n.Key, StringComparer.Ordinal);
                    foreach (var w in want)
                        if (!byKey.ContainsKey(w.Key))
                            throw new RpcException(ErrorCodes.ImportFailed, "line " + w.Line + ": " + device + " has no interface \"" + w.Key + "\" (the file lists the interfaces as rung wrote them). Nothing was changed");
                    // everything first: a subnet mask or router set on one interface changes the others on the subnet
                    var now = nodes.ToDictionary(n => n.Key, ReadSettings, StringComparer.Ordinal);
                    if (ContentHash(NetworkYaml.Render(device, nodes.Select(n => now[n.Key]))) != expectedTiaRevision)
                        throw new RpcException(ErrorCodes.StaleRevision, address + " changed in TIA Portal since it was exported");
                    foreach (var w in want) Check(byKey[w.Key], w, now[w.Key]);
                    before = now;
                    try
                    {
                        using (var tx = access.Transaction(_project, "rung import " + operationId))
                        {
                            attempted = true;
                            foreach (var w in want) Apply(byKey[w.Key], w, before[w.Key]);
                            tx.CommitOnDispose();
                        }
                    }
                    catch (Exception e) when (e is EngineeringException || e is RpcException)
                    {
                        // rolled back by now; what TIA Portal kept anyway is put back under the same exclusive access
                        var reason = e is RpcException rpc ? rpc.Message : TiaReason((EngineeringException)e);
                        throw new RpcException(e is RpcException rp ? rp.Code : ErrorCodes.ImportFailed, Sentence(reason) + RestoreNetwork(access, (DeviceItem)r.Obj, before));
                    }
                }
            }
            catch (RpcException e) when (!attempted)
            {
                throw new RpcException(e.Code, Sentence(e.Message) + " Nothing was changed.");
            }
            catch (EngineeringException e)
            {
                throw new RpcException(ErrorCodes.ImportFailed, Sentence(TiaReason(e)) + (attempted ? "" : " Nothing was changed."));
            }
            finally { _inImport = false; }
            Receipts.Write(operationId, address);
            _index.Clear();
            var result = Export(address, "yaml", WorkDir(operationId, "out"));
            if (_args.SaveAfterImport)
            {
                try { _project.Save(); }
                catch (EngineeringException) { result.Warnings = result.Warnings.Concat(new[] { WarningCodes.SaveFailed }).ToArray(); }
            }
            return result;
        }


        /// <summary>
        /// Refuses, before anything changes, a setting the interface cannot take: TIA Portal would otherwise not have
        /// it and the file would silently lose it on the way back (a subnet mask while the address comes from DHCP).
        /// </summary>
        static void Check(NetNode n, InterfaceSettings want, InterfaceSettings now)
        {
            string At(string field) => want.At(field) + n.Key + ": ";
            var ip = want.Ip ?? now.Ip;
            if (want.Ip != null && want.Ip != now.Ip && want.Ip != "dhcp" && want.Ip != "other" && !NetworkYaml.IsIpv4(want.Ip))
                throw new RpcException(ErrorCodes.ImportFailed, At("ip") + "ip \"" + want.Ip + "\" is not an IPv4 address such as 192.168.0.1, dhcp or other");
            if (!NetworkYaml.IsIpv4(ip ?? ""))
            {
                if (want.SubnetMask != null && want.SubnetMask != now.SubnetMask)
                    throw new RpcException(ErrorCodes.ImportFailed, At("subnetMask") + "the address is " + ip + ", so there is no subnet mask to set; give ip an address first");
                if (want.Router != null && want.Router != now.Router)
                    throw new RpcException(ErrorCodes.ImportFailed, At("router") + "the address is " + ip + ", so there is no router to set; give ip an address first");
            }
            if (want.DeviceName != null && want.DeviceName != now.DeviceName && now.DeviceName == null)
                throw new RpcException(ErrorCodes.ImportFailed, At("deviceName") + "this interface has no PROFINET device name");
        }

        /// <summary>Sets what the file changes; a setting it leaves out or keeps stays as it is.</summary>
        static void Apply(NetNode n, InterfaceSettings want, InterfaceSettings now)
        {
            var node = n.Node;
            string At(string field) => want.At(field) + n.Key + ": ";
            void Set(string field, Action set)
            {
                try { set(); }
                catch (EngineeringException e) { throw new RpcException(ErrorCodes.ImportFailed, At(field) + TiaReason(e)); }
            }
            if (want.Ip != null && want.Ip != now.Ip)
                Set("ip", () =>
                {
                    var choice = node.GetAttribute("IpProtocolSelection").GetType();
                    if (want.Ip == "dhcp") node.SetAttribute("IpProtocolSelection", Enum.Parse(choice, "Dhcp"));
                    else if (want.Ip == "other") node.SetAttribute("IpProtocolSelection", Enum.Parse(choice, "OtherPath"));
                    else if (!NetworkYaml.IsIpv4(want.Ip))
                        throw new RpcException(ErrorCodes.ImportFailed, At("ip") + "ip \"" + want.Ip + "\" is not an IPv4 address such as 192.168.0.1, dhcp or other");
                    else
                    {
                        if (!NetworkYaml.IsIpv4(now.Ip ?? "")) node.SetAttribute("IpProtocolSelection", Enum.Parse(choice, "Project"));
                        node.SetAttribute("Address", want.Ip);
                    }
                });
            // the mask and the router exist only while the address is set in the project
            if (NetworkYaml.IsIpv4(want.Ip ?? now.Ip ?? ""))
            {
                if (want.SubnetMask != null && want.SubnetMask != now.SubnetMask) Set("subnetMask", () => node.SetAttribute("SubnetMask", want.SubnetMask));
                if (want.Router != null && want.Router != now.Router)
                    Set("router", () =>
                    {
                        if (want.Router == NetworkYaml.None) node.SetAttribute("UseRouter", false);
                        else
                        {
                            node.SetAttribute("UseRouter", true);
                            node.SetAttribute("RouterAddress", want.Router);
                        }
                    });
            }
            if (want.DeviceName != null && want.DeviceName != now.DeviceName)
            {
                if (now.DeviceName == null) throw new RpcException(ErrorCodes.ImportFailed, At("deviceName") + "this interface has no PROFINET device name");
                Set("deviceName", () =>
                {
                    if (want.DeviceName == NetworkYaml.Auto) node.SetAttribute("PnDeviceNameAutoGeneration", true);
                    else
                    {
                        // TIA Portal takes a name only while it does not generate one
                        if (now.DeviceName == NetworkYaml.Auto) node.SetAttribute("PnDeviceNameAutoGeneration", false);
                        node.SetAttribute("PnDeviceName", want.DeviceName);
                    }
                });
            }
        }

        /// <summary>"Error when calling method 'set_Address' …\n\n300.1.1.1 is not a valid IP address": the reason only.</summary>
        static string TiaReason(Exception e)
        {
            var m = e.Message.Replace("\r\n", "\n").Trim();
            var cut = m.LastIndexOf("\n\n", StringComparison.Ordinal);
            return cut >= 0 ? m.Substring(cut + 2).Trim() : m;
        }

        static string Sentence(string s) => s.EndsWith(".", StringComparison.Ordinal) ? s : s + ".";

        /// <summary>After a failed import, under its exclusive access: puts back the settings TIA Portal kept from it. A note for the error message.</summary>
        string RestoreNetwork(ExclusiveAccess access, DeviceItem cpu, Dictionary<string, InterfaceSettings> before)
        {
            try
            {
                var nodes = NetworkNodes(cpu);
                var now = nodes.ToDictionary(n => n.Key, ReadSettings, StringComparer.Ordinal);
                var changed = nodes.Where(n => before.ContainsKey(n.Key) && NetworkYaml.Render("", new[] { now[n.Key] }) != NetworkYaml.Render("", new[] { before[n.Key] })).ToList();
                if (changed.Count == 0) return " Nothing was changed.";
                using (var tx = access.Transaction(_project, "rung restore network settings"))
                {
                    foreach (var n in changed) Apply(n, before[n.Key], now[n.Key]);
                    tx.CommitOnDispose();
                }
                return " TIA Portal had taken part of it; rung put the previous settings back.";
            }
            catch (Exception e) when (e is EngineeringException || e is RpcException)
            {
                return " Part of it may be in TIA Portal: check the network settings there (" + e.Message + ").";
            }
        }
    }
}
