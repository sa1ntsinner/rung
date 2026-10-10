// SPDX-License-Identifier: BUSL-1.1
namespace Rung.Bridge.Core
{
    /// <summary>One exported HMI object: kind (tags, screens, templates, textlists), its folders, its name and TIA Portal's XML.</summary>
    public sealed class HmiArtifact
    {
        public string Kind;
        public string[] Folders;
        public string Name;
        public string Xml;
    }
}
