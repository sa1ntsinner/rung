// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core;
using Xunit;

public class TagTableTextTests
{
    static string Tag(string id, string name, string type, string address, string comment = "", string culture = "en-US", string extra = "") =>
        "<SW.Tags.PlcTag ID=\"" + id + "\" CompositionName=\"Tags\"><AttributeList><DataTypeName>" + type + "</DataTypeName>" + extra +
        "<LogicalAddress>" + address + "</LogicalAddress><Name>" + name + "</Name></AttributeList><ObjectList><MultilingualText ID=\"" + id + "1\" CompositionName=\"Comment\"><ObjectList>" +
        "<MultilingualTextItem ID=\"" + id + "2\" CompositionName=\"Items\"><AttributeList><Culture>" + culture + "</Culture>" + (comment.Length == 0 ? "<Text />" : "<Text>" + comment + "</Text>") +
        "</AttributeList></MultilingualTextItem></ObjectList></MultilingualText></ObjectList></SW.Tags.PlcTag>";

    static string Table(string name, params string[] objects) =>
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<Document>\n  <Engineering version=\"V20\" />\n  <SW.Tags.PlcTagTable ID=\"0\"><AttributeList><Name>" + name + "</Name></AttributeList>" +
        (objects.Length > 0 ? "<ObjectList>" + string.Concat(objects) + "</ObjectList>" : "") + "</SW.Tags.PlcTagTable>\n</Document>";

    const string Constant = "<SW.Tags.PlcUserConstant ID=\"9\" CompositionName=\"UserConstants\"><AttributeList><DataTypeName>String</DataTypeName><Name>Greeting</Name><Value>'a; b // c'</Value></AttributeList></SW.Tags.PlcUserConstant>";

    static readonly string Sample = Table("Fx_Inputs",
        Tag("1", "Start", "Bool", "%I0.0", "start button"),
        Tag("2", "Level", "Byte", "%IB1005", extra: "<ExternalWritable>false</ExternalWritable>"),
        Tag("3", "Speed set &amp; ramp", "Real", "%MD10"),
        Tag("4", "Motor", "\"UDT_Motor\"", "%Q4.0"),
        Constant);

    [Fact] public void OneTagPerLineAndBackToTheSameText()
    {
        var r = TagTableText.FromXml(Sample);
        Assert.Null(r.Reason);
        Assert.Equal("en-US", r.Culture);
        Assert.Equal(
            "// PLC tag table Fx_Inputs in TIA Portal; rung sync writes changes to TIA Portal.\n" +
            "// A tag: Name AT %address : Type;  // comment        A constant: Name : Type := value;\n" +
            "// {ExternalAccessible := 'false'} hides a tag from HMI and OPC UA; ExternalVisible and ExternalWritable likewise.\n" +
            "VAR_GLOBAL\n" +
            "    Start AT %I0.0 : Bool;  // start button\n" +
            "    Level {ExternalWritable := 'false'} AT %IB1005 : Byte;\n" +
            "    \"Speed set & ramp\" AT %MD10 : Real;\n" +
            "    Motor AT %Q4.0 : \"UDT_Motor\";\n" +
            "END_VAR\n\n" +
            "VAR_GLOBAL CONSTANT\n" +
            "    Greeting : String := 'a; b // c';\n" +
            "END_VAR\n", r.Text);
        var xml = TagTableText.ToXml(r.Text, "Fx_Inputs", r.Culture, "V20");
        Assert.Contains("<ExternalWritable>false</ExternalWritable>", xml);
        Assert.Contains("<Name>Speed set &amp; ramp</Name>", xml);
        Assert.Contains("<Value>'a; b // c'</Value>", xml);
        Assert.Equal(r.Text, TagTableText.FromXml(xml).Text);
    }

    /// <summary>Every .tags.st of a real workspace survives the way to SimaticML and back (RUNG_TAGS_DIR=…/plc/PLC_1/tags).</summary>
    [Fact] public void RealTablesRoundTrip()
    {
        var dir = System.Environment.GetEnvironmentVariable("RUNG_TAGS_DIR");
        if (string.IsNullOrEmpty(dir)) return;
        var files = System.IO.Directory.GetFiles(dir, "*.tags.st");
        Assert.NotEmpty(files);
        foreach (var f in files)
        {
            var text = System.IO.File.ReadAllText(f).Replace("\r\n", "\n");
            var back = TagTableText.FromXml(TagTableText.ToXml(text, "T", "en-US", "V20"));
            Assert.True(back.Reason == null, f + ": " + back.Reason);
            Assert.Equal(text.Substring(text.IndexOf("\nVAR_GLOBAL", System.StringComparison.Ordinal)), back.Text.Substring(back.Text.IndexOf("\nVAR_GLOBAL", System.StringComparison.Ordinal)));
        }
    }

    [Fact] public void AnEmptyTableIsAnEmptyList()
    {
        var r = TagTableText.FromXml(Table("Default tag table"));
        Assert.EndsWith("VAR_GLOBAL\nEND_VAR\n", r.Text);
        Assert.Equal(r.Text, TagTableText.FromXml(TagTableText.ToXml(r.Text, "Default tag table", null, "V20")).Text);
    }

    [Theory]
    [InlineData("two languages", "its comments are in more than one language (en-US, de-DE)")]
    [InlineData("setting", "a tag has the setting Retain")]
    [InlineData("system", "the table holds SW.Tags.PlcSystemConstant")]
    [InlineData("lines", "the comment of B has several lines")]
    public void StaysXmlWhenTheTextWouldLoseSomething(string what, string reason)
    {
        var xml = what == "two languages" ? Table("T", Tag("1", "A", "Bool", "%M0.0", "hello"), Tag("2", "B", "Bool", "%M0.1", "hallo", "de-DE"))
            : what == "setting" ? Table("T", Tag("1", "A", "Bool", "%M0.0", extra: "<Retain>true</Retain>"))
            : what == "system" ? Table("T", "<SW.Tags.PlcSystemConstant ID=\"1\"><AttributeList><Name>X</Name></AttributeList></SW.Tags.PlcSystemConstant>")
            : Table("T", Tag("1", "B", "Bool", "%M0.0", "one\ntwo"));
        var r = TagTableText.FromXml(xml);
        Assert.Null(r.Text);
        Assert.Equal(reason, r.Reason);
    }

    [Theory]
    [InlineData("VAR_GLOBAL\n  A : Bool;\nEND_VAR\n", "line 2: A has no address: a PLC tag is at an address (A AT %M10.0 : Bool;)")]
    [InlineData("VAR_GLOBAL\n  A AT %M0.0 : Bool\nEND_VAR\n", "line 2: missing ';' (one tag per line)")]
    [InlineData("VAR_GLOBAL\n  A AT %M0.0 : Bool;\n  a AT %M0.1 : Bool;\nEND_VAR\n", "line 3: a is declared twice (line 2)")]
    [InlineData("VAR_GLOBAL\n  A AT M0.0 : Bool;\nEND_VAR\n", "line 2: M0.0 is not an address such as %I0.0, %QW4 or %MD10")]
    [InlineData("VAR_GLOBAL\n  A AT %M0.0 : Bool := TRUE;\nEND_VAR\n", "line 2: a PLC tag has no start value in TIA Portal; constants go in VAR_GLOBAL CONSTANT")]
    [InlineData("VAR_GLOBAL CONSTANT\n  K : Int;\nEND_VAR\n", "line 2: a constant needs a value: K : Int := 10;")]
    [InlineData("VAR_GLOBAL\n  A {Hidden := 'true'} AT %M0.0 : Bool;\nEND_VAR\n", "line 2: unknown setting Hidden := 'true' (ExternalAccessible := 'false', ExternalVisible := 'false', ExternalWritable := 'false')")]
    [InlineData("  A AT %M0.0 : Bool;\n", "line 1: a tag belongs between VAR_GLOBAL and END_VAR")]
    [InlineData("VAR_GLOBAL\n  A AT %M0.0 : Bool;\n", "line 3: END_VAR is missing")]
    [InlineData("VAR_GLOBAL\n  A AT %M0.0 : Bool; (* old *)\nEND_VAR\n", "line 2: use // for a comment, it belongs to the tag on its line")]
    public void RefusesWithTheLine(string text, string message) =>
        Assert.Equal(message, Assert.Throws<TagTableTextException>(() => TagTableText.ToXml(text, "T", "en-US", "V20")).Message);
}
