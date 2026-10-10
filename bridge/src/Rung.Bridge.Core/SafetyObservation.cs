// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Linq;
using Rung.Bridge.Core.Protocol;
namespace Rung.Bridge.Core {
 public sealed class SafetySignatureValue{public string Type,Value,RuntimeType,Address;}
 public sealed class SafetyObservation{public string Status,Reason,Device,SystemVersion,SystemVersionStatus,Source="TIA offline engineering service";public SafetySignatureValue[] Signatures;}
 public static class SafetyObservationPlan {
  public static void Check(SafetyObservation value){if(value==null||!new[]{"available","unavailable","error"}.Contains(value.Status)||value.Reason?.Length>4096||value.SystemVersion?.Length>128)throw new RpcException(ErrorCodes.UnsupportedCapability,"Invalid safety service observation");if(value.Status=="available"&&(value.Signatures==null||value.Signatures.Length<1||value.Signatures.Length>4096||value.Signatures.Any(s=>s==null||s.Type!="BlockOfflineSignature"||string.IsNullOrWhiteSpace(s.Value)||s.Value.Length>1024||s.Value.Any(char.IsControl)||string.IsNullOrWhiteSpace(s.Address)||s.Address.Length>1024)))throw new RpcException(ErrorCodes.UnsupportedCapability,"Unknown or empty safety signature; no safety approval is inferred");if(value.Status!="available"&&(string.IsNullOrWhiteSpace(value.Reason)||value.Signatures!=null))throw new RpcException(ErrorCodes.UnsupportedCapability,"Unavailable/error safety service requires an explicit reason and no successful signatures");}
 }
}
