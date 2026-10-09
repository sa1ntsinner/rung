// SPDX-License-Identifier: MIT
#nullable enable
using S7CommPlusDriver;
using Rung.Online;
using System.Text.Json;
if(args.Length!=1 || new FileInfo(args[0]).Length>1_048_576)throw new Exception("One bounded fixture request is required");
var root=JsonDocument.Parse(File.ReadAllText(args[0])).RootElement;
if(root.GetProperty("fixture").GetString()!="RungProve" || root.GetProperty("address").GetString()!="192.168.250.1" || root.GetProperty("number").GetInt32()!=4)throw new Exception("Fixture-only request required");
var attributes=root.GetProperty("job").GetProperty("attributes");
if(attributes.GetProperty("2691").GetString()!="False")throw new Exception("Modifying request refused");
// Only the independently validated fixture request may reach the driver.
var reference=JsonDocument.Parse(File.ReadAllText("tools/prove/captures/tis-generated-prepost.json")).RootElement;
if(attributes.GetProperty("2693").GetString()!=reference.GetProperty("job").GetProperty("attributes").GetProperty("2693").GetString())throw new Exception("Unvalidated native request refused");
var trigger=Convert.FromHexString(attributes.GetProperty("2694").GetString()!);
var referenceTrigger=Convert.FromHexString(reference.GetProperty("job").GetProperty("attributes").GetProperty("2694").GetString()!);
if(trigger.Length!=24 || !trigger.AsSpan(0,5).SequenceEqual(referenceTrigger.AsSpan(0,5)) || !trigger.AsSpan(9).SequenceEqual(referenceTrigger.AsSpan(9)))throw new Exception("Unvalidated native trigger refused");
if(!root.TryGetProperty("caller",out _) || !root.TryGetProperty("codeModifiedTimestamp",out _))throw new Exception("Native source guards required");
await using var client=new S7CommPlusClient(new(){Address="192.168.250.1",CertificateSha256=Environment.GetEnvironmentVariable("RUNG_TEST_CERT_SHA256"),AutoReconnect=false});
await client.ConnectAsync();
var identity=await client.GetCpuInfoAsync();
if(identity.PlcName!="PLC_1" || identity.CpuSerial!=root.GetProperty("serial").GetString())throw new Exception("Fixture identity changed");
NativeCapturePlan? generated=null;
async Task ValidateSignatures(){
 var blocks=await client.BrowseBlocksAsync();
 if(root.TryGetProperty("codeModifiedTimestamp",out var timestamp)){
  var block=blocks.Single(b=>b.Name=="FB_ProveOps" && b.Number==4 && b.Type.ToString()=="FB");
  var current=await client.GetBlockContentAsync(block.RelationId);
  if(!current.CodeModifiedTimestampBytes.AsSpan().SequenceEqual(Convert.FromBase64String(timestamp.GetString()!)))throw new Exception("Native code signature changed");
  var bodies=current.BlockBody.Select(NativeSource.Render).ToArray();
  var scalars=current.BlockBody.SelectMany(body=>NativeSource.Scalars(current.FunctionalObjectDebugInfo,body,4)).ToDictionary(b=>b.Name);
  foreach(var field in reference.GetProperty("layout").EnumerateArray().Where(v=>v.GetProperty("phase").GetString()=="before")){
   var binding=scalars[field.GetProperty("name").GetString()!];
   if(binding.BitOffset!=field.GetProperty("bitOffset").GetUInt32() || binding.Type!=field.GetProperty("type").GetString() || Math.Max(1,binding.Bits/8)!=field.GetProperty("bytes").GetUInt32())throw new Exception("Native capture layout changed");
  }
  if(scalars.Count!=35)throw new Exception("Incomplete native state bindings");
  if(generated==null){
   var ordered=reference.GetProperty("layout").EnumerateArray().Where(v=>v.GetProperty("phase").GetString()=="before").Select(v=>scalars[v.GetProperty("name").GetString()!]).ToArray();
   var guid=Guid.NewGuid().ToByteArray();uint uid=0;foreach(var part in new[]{0,4,8,12})uid^=BitConverter.ToUInt32(guid,part);
   generated=NativeCaptureEncoder.Build(4,current.CodeModifiedTimestampBytes,ordered,uid);
   if(!generated.Request.RequestBlob.AsSpan().SequenceEqual(Convert.FromHexString(attributes.GetProperty("2693").GetString()!)))throw new Exception("Generated fixture request differs from validated reference");
  }
  Console.WriteLine(JsonSerializer.Serialize(new{nativeSource=true,block=current.Name,codeModifiedTimestamp=timestamp.GetString(),bodies,scalars=scalars.Values}));
 }
 if(root.TryGetProperty("caller",out var caller)){
  var block=blocks.Single(b=>b.Name==caller.GetProperty("block").GetString() && b.Number==caller.GetProperty("number").GetInt32() && b.Type.ToString()=="OB");
  var current=await client.GetBlockContentAsync(block.RelationId);
  if(!current.CodeModifiedTimestampBytes.AsSpan().SequenceEqual(Convert.FromBase64String(caller.GetProperty("codeModifiedTimestamp").GetString()!)))throw new Exception("Caller code signature changed");
  var route=NativeSource.RootCall(current.FunctionalObjectDebugInfo,current.BlockBody[caller.GetProperty("cuId").GetInt32()-1],current.InternalReferences.ToArray(),caller.GetProperty("sac").GetUInt32());
  if(route.Instance!=caller.GetProperty("instance").GetString() || route.FunctionBlock!=root.GetProperty("number").GetUInt32()
     || route.Database!=4 || route.Element!=caller.GetProperty("elementId").GetInt32().ToString())throw new Exception("Instance route changed");
  Console.WriteLine(JsonSerializer.Serialize(new{nativeRoute=route}));
 }
}
await ValidateSignatures();
var request=generated!.Request;
var received=new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);int count=0;Exception? failure=null;
await using(var subscription=await client.OpenBlockOnlineViewAsync(request,new(){NotificationTimeout=TimeSpan.FromSeconds(2)})){
 subscription.NotificationReceived+=(_,e)=>{
  try {
   var raw=e.Notification.RawResult;
   if(e.Notification.JobEnabled!=true)throw new Exception("Native watch disabled or unknown");
   if(raw.Length!=reference.GetProperty("resultBytes").GetInt32())throw new Exception("Incomplete native payload");
   foreach(var value in reference.GetProperty("layout").EnumerateArray())if(raw[value.GetProperty("validity").GetInt32()]!=15)throw new Exception("Invalid native value");
   var state=NativeCaptureEncoder.Decode(generated!,raw);
   var caller=root.GetProperty("caller");var frame=NativeCaptureEncoder.RootCaller(raw);
   if(frame.Number!=caller.GetProperty("number").GetUInt32() || frame.Sac!=caller.GetProperty("sac").GetUInt32())throw new Exception("Native caller changed");
   Console.WriteLine(JsonSerializer.Serialize(new{timestamp=DateTime.UtcNow,sequence=e.Notification.SequenceNumber,enabled=e.Notification.JobEnabled,coherence="subscription-sample",before=state.Before,after=state.After,result=Convert.ToHexString(raw)}));
   if(Interlocked.Increment(ref count)>=3)received.TrySetResult(true);
  } catch(Exception error){Interlocked.CompareExchange(ref failure,error,null);received.TrySetException(error);}
 };
 await received.Task.WaitAsync(TimeSpan.FromSeconds(20));
 if(count<3)throw new Exception("Insufficient actual notifications");
}
if(failure!=null)throw failure;
await ValidateSignatures(); Console.WriteLine(JsonSerializer.Serialize(new{disposed=true,notifications=count,signaturesValidated=true}));


