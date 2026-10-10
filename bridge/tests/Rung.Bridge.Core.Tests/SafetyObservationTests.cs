// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core;
using Rung.Bridge.Core.Protocol;
using Xunit;
public class SafetyObservationTests {
 [Fact]public void MissingOrFailedServicesAreNotEmptyValidSignatures(){SafetyObservationPlan.Check(new SafetyObservation{Status="unavailable",Reason="No F fixture"});SafetyObservationPlan.Check(new SafetyObservation{Status="error",Reason="Authorization denied"});Assert.Throws<RpcException>(()=>SafetyObservationPlan.Check(new SafetyObservation{Status="available",Signatures=new SafetySignatureValue[0]}));Assert.Throws<RpcException>(()=>SafetyObservationPlan.Check(new SafetyObservation{Status="available",Signatures=new[]{new SafetySignatureValue{Type="unknown",Value="123",Address="FB"}}}));}
}
