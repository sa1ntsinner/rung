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
        /// <summary>TIA Portal refuses an archive path longer than this (V20, without the extension).</summary>
        const int MaxArchivePath = 143;

        /// <summary>Eight hex digits that tell projects of the same name apart: their full paths, letter case aside.</summary>
        static string PathId(string fullPath)
        {
            using (var sha = System.Security.Cryptography.SHA256.Create())
                return string.Concat(sha.ComputeHash(System.Text.Encoding.UTF8.GetBytes(fullPath.ToLowerInvariant())).Take(4).Select(b => b.ToString("x2")));
        }

        public ArchiveOutcome Archive(string directory, int keep)
        {
            Alive();
            var project = Path.GetFileNameWithoutExtension(_project.Path.Name);
            // one folder per project, not per name: two copies of Line1.ap20 must not rotate each other's archives away
            var dir = string.IsNullOrEmpty(directory)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "rung", "backups", project + "-" + PathId(_project.Path.FullName))
                : directory;
            // .ap20 → .zap20, .ap21 → .zap21
            var ext = ".z" + _project.Path.Extension.TrimStart('.');
            var stem = Path.Combine(dir, project + "_" + DateTime.Now.ToString("yyyyMMdd_HHmmss"));
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
            foreach (var old in new DirectoryInfo(dir).GetFiles(project + "_*" + ext).Where(f => f.FullName != file.FullName).OrderByDescending(f => f.Name).Skip(Math.Max(keep, 1) - 1))
            {
                try { old.Delete(); removed.Add(old.FullName); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            return new ArchiveOutcome { Path = file.FullName, Bytes = file.Length, SavedFirst = saved, Removed = removed.ToArray() };
        }
    }
}
