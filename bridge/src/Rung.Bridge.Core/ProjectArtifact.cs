// SPDX-License-Identifier: BUSL-1.1
using System;
using System.Text;
using System.Text.Json;
using Rung.Bridge.Core.Protocol;
namespace Rung.Bridge.Core {
 public sealed class ArtifactState { public string ProjectRevision,ContentRevision; }
 public sealed class ArtifactExport { public string ContentBase64,Revision,ArtifactRevision;public string[] Languages; }
 public sealed class ArtifactPreview { public string Revision,ArtifactRevision;public object[] Changes; }
 public sealed class ArtifactResult { public string Revision;public bool Saved;public string[] Warnings; }
 public static class ArtifactPlan {
  public static string Revision(ArtifactState state){if(state?.ProjectRevision==null||state.ContentRevision==null||state.ProjectRevision.Length>1024||state.ContentRevision.Length>1024)throw new RpcException(ErrorCodes.BadRequest,"Incomplete artifact state");return Bundle.Sha256(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(state,RpcWire.Json)));}
  public static string Apply(Func<ArtifactState> read,string expectedRevision,string desired,Action import,Action<Action> transaction){LibraryImportPlan.CheckRevision(expectedRevision);var before=read();var revision=Revision(before);if(revision!=expectedRevision)throw new RpcException(ErrorCodes.StaleRevision,"Project/artifact changed since preview");var expected=Revision(new ArtifactState{ProjectRevision=before.ProjectRevision,ContentRevision=desired});
   try{transaction(()=>{import();if(Revision(read())!=expected)throw new RpcException(ErrorCodes.ImportFailed,"Native artifact import changed unreviewed state");});if(Revision(read())!=expected)throw new RpcException(ErrorCodes.ImportFailed,"Commit changed validated artifact state");return expected;}
   catch(Exception error){try{if(Revision(read())!=revision)throw new InvalidOperationException("Original artifact/project differs");}catch(Exception restoration){throw new RpcException(ErrorCodes.ImportFailed,"RESTORATION FAILED after artifact import: "+restoration.Message+"; original error: "+error.Message);}throw new RpcException(ErrorCodes.ImportFailed,"Artifact import refused; original state restored: "+error.Message);}
  }
 }
}
