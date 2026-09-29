// SPDX-License-Identifier: BUSL-1.1
using Rung.Bridge.Core;
using Xunit;

// Seen live on TIA Portal V20 without updates: a LAD network title is in the SimaticML export, while the SD
// export of the same block has no trace of it (.s7res is "<root />").
public class SdCheckTests
{
    const string LadWithTitle = @"<Document><SW.Blocks.FB ID=""0""><AttributeList>
  <Interface><Sections xmlns=""http://www.siemens.com/automation/Openness/SW/Interface/v5""><Section Name=""Input"">
    <Member Name=""Speed"" Datatype=""Real""><Comment><MultiLanguageText Lang=""en-US"">rpm</MultiLanguageText></Comment></Member>
  </Section></Sections></Interface></AttributeList>
  <ObjectList>
    <MultilingualText ID=""1"" CompositionName=""Comment""><ObjectList><MultilingualTextItem ID=""2"" CompositionName=""Items""><AttributeList><Culture>en-US</Culture><Text /></AttributeList></MultilingualTextItem></ObjectList></MultilingualText>
    <SW.Blocks.CompileUnit ID=""3""><ObjectList>
      <MultilingualText ID=""4"" CompositionName=""Title""><ObjectList><MultilingualTextItem ID=""5"" CompositionName=""Items""><AttributeList><Culture>en-US</Culture><Text>Start/stop latch</Text></AttributeList></MultilingualTextItem></ObjectList></MultilingualText>
    </ObjectList></SW.Blocks.CompileUnit>
  </ObjectList></SW.Blocks.FB></Document>";

    [Fact] public void ANetworkTitleMissingFromSdIsReported()
    {
        var sd = "FUNCTION_BLOCK \"Fx\"\n VAR_INPUT\n  Speed : Real; // rpm\n END_VAR\n NETWORK\n END_NETWORK\n<root />";
        Assert.Equal(new[] { "Start/stop latch" }, SdCheck.MissingTexts(LadWithTitle, sd));
    }

    [Fact] public void NothingIsMissingWhenSdCarriesTheTexts() =>
        Assert.Empty(SdCheck.MissingTexts(LadWithTitle, "Speed : Real; // rpm\n<root><Text>Start/stop latch</Text></root>"));

    [Fact] public void EmptyTextsDoNotCount() =>
        Assert.Empty(SdCheck.MissingTexts("<Document><AttributeList><Text>  </Text></AttributeList></Document>", ""));

    [Fact] public void OnlyProgramCycleObsKeepTheirTypeInSd()
    {
        Assert.False(SdCheck.LosesObType(LadWithTitle));
        Assert.False(SdCheck.LosesObType("<Document><SW.Blocks.OB><AttributeList><SecondaryType>ProgramCycle</SecondaryType></AttributeList></SW.Blocks.OB></Document>"));
        Assert.True(SdCheck.LosesObType("<Document><SW.Blocks.OB><AttributeList><SecondaryType>CyclicInterrupt</SecondaryType></AttributeList></SW.Blocks.OB></Document>"));
    }
}
