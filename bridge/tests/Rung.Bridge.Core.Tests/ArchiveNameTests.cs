// SPDX-License-Identifier: BUSL-1.1
using System.IO;
using Rung.Bridge.Core;
using Xunit;

// The default place of rung's daily archive: one folder per project file, and always within TIA Portal's 143 characters.
public class ArchiveNameTests
{
    static readonly string Root = Path.Combine(Path.GetTempPath(), "rung", "backups");
    const int Stamp = 16; // _yyyyMMdd_HHmmss

    [Fact]
    public void ProjectNameAndIdOfItsPath()
    {
        var file = Path.Combine(Path.GetTempPath(), "TIA", "Line1", "Line1.ap20");
        var p = ArchiveName.Default(Root, file);
        Assert.Equal(Path.Combine(Root, "Line1-" + ArchiveName.PathId(file)), p.Dir);
        Assert.Equal("Line1", p.Name);
        Assert.Matches("^[0-9a-f]{8}$", ArchiveName.PathId(file));
    }

    [Fact]
    public void TwoCopiesOfOneNameGetTwoFoldersAndLetterCaseDoesNotCount()
    {
        var a = Path.Combine(Path.GetTempPath(), "TIA", "Line1", "Line1.ap20");
        var b = Path.Combine(Path.GetTempPath(), "Copy", "Line1", "Line1.ap20");
        Assert.NotEqual(ArchiveName.Default(Root, a).Dir, ArchiveName.Default(Root, b).Dir);
        Assert.Equal(ArchiveName.PathId(a), ArchiveName.PathId(a.ToUpperInvariant()));
    }

    [Fact]
    public void ALongProjectNameStillFits()
    {
        var name = new string('L', 90);
        var file = Path.Combine(Path.GetTempPath(), "TIA", name + ".ap20");
        var p = ArchiveName.Default(Root, file);
        Assert.Equal(Path.Combine(Root, ArchiveName.PathId(file)), p.Dir);
        Assert.StartsWith(p.Name, name);
        Assert.True(p.Dir.Length + 1 + p.Name.Length + Stamp <= ArchiveName.MaxPath);
    }

    [Fact]
    public void NothingFitsUnderAFolderThatIsTooLongAlready()
    {
        var root = Path.Combine(Path.GetTempPath(), new string('x', 140));
        Assert.Null(ArchiveName.Default(root, Path.Combine(Path.GetTempPath(), "Line1.ap20")));
    }
}
