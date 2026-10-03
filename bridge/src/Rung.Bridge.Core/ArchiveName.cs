// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Rung.Bridge.Core
{
    /// <summary>
    /// Where rung's daily archive of a project goes when rung.toml names no folder:
    /// backups\Line1-1a2b3c4d\Line1_20261003_065117.zap20, one folder per project file (two copies of Line1.ap20 must
    /// not rotate each other's archives away). TIA Portal takes archive paths of at most 143 characters (without the
    /// extension): a long project name in a long user folder gets the folder by its id alone and the file name cut to fit.
    /// </summary>
    public static class ArchiveName
    {
        /// <summary>TIA Portal refuses an archive path longer than this (V20, without the extension).</summary>
        public const int MaxPath = 143;

        /// <summary>The length of what follows the name: _yyyyMMdd_HHmmss.</summary>
        const int StampLength = 16;

        /// <summary>Eight hex digits that tell projects of the same name apart: their full paths, letter case aside.</summary>
        public static string PathId(string fullPath)
        {
            using (var sha = SHA256.Create())
                return string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(fullPath.ToLowerInvariant())).Take(4).Select(b => b.ToString("x2")));
        }

        /// <summary>
        /// The folder and the start of the file name (before _yyyyMMdd_HHmmss) for a project file under rung's backups
        /// folder; null when not even the shortest fits.
        /// </summary>
        public static Place Default(string backupsRoot, string projectFile)
        {
            var project = Path.GetFileNameWithoutExtension(projectFile);
            var id = PathId(projectFile);
            var dir = Path.Combine(backupsRoot, project + "-" + id);
            if (dir.Length + 1 + project.Length + StampLength <= MaxPath) return new Place(dir, project);
            dir = Path.Combine(backupsRoot, id);
            var room = MaxPath - dir.Length - 1 - StampLength;
            return room >= 1 ? new Place(dir, project.Substring(0, Math.Min(project.Length, room))) : null;
        }

        public sealed class Place
        {
            public Place(string dir, string name) { Dir = dir; Name = name; }
            public string Dir { get; }
            public string Name { get; }
        }
    }
}
