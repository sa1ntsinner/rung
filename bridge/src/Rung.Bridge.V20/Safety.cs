// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Linq;
using System.Collections.Generic;
using System.Globalization;
using Rung.Bridge.Core;
using Siemens.Engineering;
using Siemens.Engineering.Safety;
namespace Rung.Bridge.V20 {
 public sealed partial class OpennessSession {
  public SafetyObservation ObserveSafety(string device){Alive();var plc=Plc(device);var result=new SafetyObservation{Device=plc.Name,Status="unavailable",Reason="No offline signature service is available on the PLC or its F blocks",SystemVersionStatus="unavailable"};using(var access=_portal.ExclusiveAccess("rung: read-only safety observation")){
   try{var signatures=new List<SafetySignatureValue>();void Read(IEngineeringServiceProvider obj,string address){var provider=obj.GetService<SafetySignatureProvider>();if(provider==null)return;if(provider.Signatures.Count>4096-signatures.Count)throw new InvalidOperationException("Safety signature limit exceeded");foreach(var s in provider.Signatures)signatures.Add(new SafetySignatureValue{Address=address,Type=s.Type.ToString(),Value=Convert.ToString(s.Value,CultureInfo.InvariantCulture),RuntimeType=((object)s.Value)?.GetType().FullName});}
    Read(plc,"plc:"+plc.Name);foreach(var entry in ListObjects(plc.Name).Where(e=>e.IsFailsafe))Read((IEngineeringServiceProvider)_index[entry.Address].Obj,entry.Address);
    var settings=plc.GetService<SafetyAdministration>()?.Settings;if(settings?.SafetySystemVersion?.Value!=null){result.SystemVersion=settings.SafetySystemVersion.Value;result.SystemVersionStatus="available";}
    if(signatures.Count>0){result.Status="available";result.Reason=null;result.Signatures=signatures.ToArray();}SafetyObservationPlan.Check(result);return result;
   }catch(Exception error)when(error is EngineeringException||error is InvalidOperationException||error is Rung.Bridge.Core.Protocol.RpcException){result.Status="error";result.Signatures=null;result.Reason=error.Message.Length>4096?error.Message.Substring(0,4096):error.Message;result.SystemVersion=null;result.SystemVersionStatus="error";return result;}
  }}
 }
}
