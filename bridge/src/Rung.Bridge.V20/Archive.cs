// SPDX-License-Identifier: BUSL-1.1
// A project archive before rung writes into the project: TIA Portal's own .zap file, which Project → Retrieve opens.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Siemens.Engineering;

namespace Rung.Bridge.V20
{
    public sealed partial class OpennessSession
    {
        const int MaxArchivePath = ArchiveName.MaxPath;

        public ArchiveOutcome Archive(string directory, int keep)
        {
            Alive();
            var project = Path.GetFileNameWithoutExtension(_project.Path.Name);
            // one folder per project file, not per name (ArchiveName); a folder of the person's own as it is
            var place = string.IsNullOrEmpty(directory)
                ? ArchiveName.Default(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "rung", "backups"), _project.Path.FullName)
                : new ArchiveName.Place(directory, project);
            if (place == null)
                throw new RpcException(ErrorCodes.BadRequest, "TIA Portal takes archive paths of at most " + MaxArchivePath + " characters, and rung's folder for them is too long here: choose a shorter folder (backupDir under [sync] in rung.toml)");
            var dir = place.Dir;
            // .ap20 → .zap20, .ap21 → .zap21
            var ext = ".z" + _project.Path.Extension.TrimStart('.');
            var stem = Path.Combine(dir, place.Name + "_" + DateTime.Now.ToString("yyyyMMdd_HHmmss"));
            if (stem.Length > MaxArchivePath)
                throw new RpcException(ErrorCodes.BadRequest, "TIA Portal takes archive paths of at most " + MaxArchivePath + " characters; " + stem + " has " + stem.Length + ": choose a shorter folder (backupDir under [sync] in rung.toml)");
            Directory.CreateDirectory(dir);
            // TIA Portal archives only a saved project ("Operation is not possible while project has unsaved changes")
            var saved = false;
            try
            {
                if (_project.IsModified) { _project.Save(); saved = true; }
                _project.Archive(new DirectoryInfo(dir), Path.GetFileName(stem) + ext, ProjectArchivationMode.Compressed);
            }
            catch (EngineeringException e) { throw new RpcException(ErrorCodes.Internal, "TIA Portal could not archive the project: " + TiaText.Clean(e.Message)); }
            var file = new FileInfo(stem + ext);
            if (!file.Exists) throw new RpcException(ErrorCodes.Internal, "TIA Portal reported no error, but there is no archive at " + file.FullName);
            // the newest archives of this project stay; never the one just written
            var removed = new List<string>();
            foreach (var old in new DirectoryInfo(dir).GetFiles(place.Name + "_*" + ext).Where(f => f.FullName != file.FullName).OrderByDescending(f => f.Name).Skip(Math.Max(keep, 1) - 1))
            {
                try { old.Delete(); removed.Add(old.FullName); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            return new ArchiveOutcome { Path = file.FullName, Bytes = file.Length, SavedFirst = saved, Removed = removed.ToArray() };
        }
    }
}
