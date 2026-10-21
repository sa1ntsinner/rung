// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Linq;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;

namespace Rung.Bridge.V20
{
    /// <summary>
    /// rung init --new --cpu &lt;order number&gt;: the CPU of a project this bridge just created, with the newest firmware
    /// of that order number in the installed catalog, set up as TIA Portal's wizard does for a lab PLC (no
    /// configuration-data password, full access, no secure-only PG/PC communication) so its hardware compiles.
    /// </summary>
    static class NewStation
    {
        public static void Add(TiaPortal portal, Project project, BridgeArgs args)
        {
            if (string.IsNullOrEmpty(args.NewCpu)) return;
            var order = args.NewCpu.Trim();
            var entries = portal.HardwareCatalog.Find(order).Where(e => e.TypeIdentifier.StartsWith("OrderNumber:" + order + "/", StringComparison.OrdinalIgnoreCase)).ToList();
            if (entries.Count == 0) throw new RpcException(ErrorCodes.BadRequest, "CPU " + order + " is not in the hardware catalog of this TIA Portal (an order number such as 6ES7 516-3AN02-0AB0)");
            var typeId = entries.OrderBy(e => Firmware(e.TypeIdentifier)).Last().TypeIdentifier;
            var name = string.IsNullOrEmpty(args.NewDevice) ? "PLC_1" : args.NewDevice;
            var device = project.Devices.CreateWithItem(typeId, name, name);
            var cpu = device.DeviceItems.FirstOrDefault(d => d.GetService<SoftwareContainer>()?.Software is PlcSoftware);
            if (cpu == null) throw new RpcException(ErrorCodes.BadRequest, order + " is not a CPU with a PLC program");
            try
            {
                var secret = cpu.GetService<PlcMasterSecretConfigurator>();
                if (secret != null && secret.MasterSecretConfiguration != MasterSecretConfiguration.None) secret.Unprotect();
                var access = cpu.GetService<PlcAccessLevelProvider>();
                if (access != null) access.PlcProtectionAccessLevel = PlcProtectionAccessLevel.FullAccess;
                cpu.SetAttribute("CommunicationMode", 0u);
            }
            // an S7-1200 or an older firmware has fewer of these settings; the rest of the station is still usable
            catch (EngineeringException) { }
            // TIA Portal exports no block it has not compiled yet: the new Main [OB1] would stay out of the files
            (cpu.GetService<SoftwareContainer>().Software as PlcSoftware).GetService<ICompilable>()?.Compile();
            project.Save();
        }

        static Version Firmware(string typeId)
        {
            var v = typeId.Substring(typeId.LastIndexOf("/V", StringComparison.Ordinal) + 2);
            return Version.TryParse(v, out var parsed) ? parsed : new Version(0, 0);
        }
    }
}
