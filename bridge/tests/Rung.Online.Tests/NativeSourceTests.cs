// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;
using Xunit;

namespace Rung.Online.Tests;

public sealed class NativeSourceTests
{
    [Fact]
    public void ResolvesRootInstanceThroughNativeCallSymbolsAndCrossReferences()
    {
        const string debug = "<DebugInfo><Operand sac='118' cuId='3' elementId='258'/></DebugInfo>";
        const string body = "<Network RefID='3'><InstCa><Sub UId='258' SI='DB' SyId='17' ODN='&quot;Counter_DB&quot;'/></InstCa><DBBlock SymID='17' RefId='11' TypeSymID='18'/><FBBlock SymID='18' RefId='12'/></Network>";
        const string references = "<IdentContainer><Ident Name='Counter_DB' Scope='Global' RefId='11'><CrossRefInfo><XRefItem UId='258' Usage='InstanceDB' NetId='3'/></CrossRefInfo><Access><AufDBBlock BlockNumber='17' BlockType='DB' TypeName='Counter' RId='44'/></Access></Ident><Ident Name='Counter' Scope='Global' RefId='12'><CrossRefInfo><XRefItem UId='258' Usage='Call' NetId='3' Name='&quot;Counter_DB&quot;'/></CrossRefInfo><Access><FBBlock BlockNumber='256' BlockType='FB' TypeName='Counter' RId='44'/></Access></Ident></IdentContainer>";
        var route = NativeSource.RootCall(debug, body, [references], 118);
        Assert.Equal("Counter_DB", route.Instance);
        Assert.Equal(17u, route.Database);
        Assert.Equal(256u, route.FunctionBlock);
        Assert.Equal(route, Assert.Single(NativeSource.RootCallSites(debug, [body], [references], "Counter_DB")));
        Assert.Equal(2, NativeSource.RootCallSites(debug.Replace("</DebugInfo>", "<Operand sac='94' cuId='3' elementId='258'/></DebugInfo>"), [body], [references], "Counter_DB").Length);
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCallSites(debug, [body], [references], "Other_DB"));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCallSites(debug, [body, body], [references], "Counter_DB"));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCall(debug, body, [references], 119));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCall(debug, body.Replace("SI='DB'", "SI='Local'"), [references], 118));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCall(debug, body, [references.Replace("Usage='Call'", "Usage='Read'")], 118));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCall(debug, body, [references.Replace("BlockType='FB'", "BlockType='FC'")], 118));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCall(debug, body, [references.Replace("RId='44'/></Access></Ident></IdentContainer>", "RId='45'/></Access></Ident></IdentContainer>")], 118));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCall(debug, body, [references, references], 118));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCall(debug.Replace("cuId='3'", "cuId='1'"), body, [references], 118));
        Assert.ThrowsAny<Exception>(() => NativeSource.RootCall(debug, body.Replace("SyId='17'", "").Replace("SymID='17'", ""), [references], 118));
    }

    const string ScalarBody = "<Network Lang='SCL' RefID='1'><RootStatements><SymVa UId='7' ODN='#Count'/></RootStatements></Network>";
    static string Debug(uint block, uint bits, string offset = "32") => $$"""
        <DebugInfo><Monitoring><LanguageElement cuId="1" elementId="7">
        <MonitoringElement type="{Scalar&quot;33554439&quot;DInt}" debugValueRef="3"/>
        </LanguageElement><DebugValue id="3" bitSize="{{bits}}"><Indirect
        typeSafe="true" granted="true" pointerScope="NativeBlock" pointerNumber="{{block}}" bitOffset="{{offset}}"/>
        </DebugValue></Monitoring></DebugInfo>
        """;

    [Fact]
    public void JoinsNativeScalarAddressToItsSourceSymbolAndBlock()
    {
        var binding = Assert.Single(NativeSource.Scalars(Debug(256, 32), ScalarBody, 256));
        Assert.Equal(new NativeScalar("COUNT", 32, 32, "{Scalar\"33554439\"DInt}"), binding);
        var temporary = Debug(256, 32).Replace("</LanguageElement>", "<MonitoringElement type='{Scalar&amp;quot;33554439&amp;quot;DInt}' debugValueRef='4'/></LanguageElement>")
            .Replace("</Monitoring>", "<DebugValue id='4' bitSize='32'><Addr><Native scope='NativeLocal' location='Slot32' locationNumber='0'/></Addr></DebugValue></Monitoring>");
        Assert.Equal(binding, Assert.Single(NativeSource.Scalars(temporary, ScalarBody, 256)));
        Assert.ThrowsAny<Exception>(() => NativeSource.Scalars(Debug(4, 32), ScalarBody, 256));
        Assert.ThrowsAny<Exception>(() => NativeSource.Scalars(Debug(256, 32).Replace("cuId=\"1\"", "cuId=\"2\""), ScalarBody, 256));
        Assert.ThrowsAny<Exception>(() => NativeSource.Scalars(Debug(256, 32).Replace("granted=\"true\"", "granted=\"false\""), ScalarBody, 256));
        Assert.ThrowsAny<Exception>(() => NativeSource.Scalars(Debug(256, 32).Replace("elementId=\"7\"", "elementId=\"8\""), ScalarBody, 256));
    }

    [Fact]
    public void PreservesStringWhitespaceAndExplicitSyntax()
    {
        var body = NativeSource.Render("""
            <Network Lang="SCL" RefID="1"><SCLSource><RootStatements>
            <Statement UId="1"><SymVa ODN="#text"/><BL/><OpAs/><BL/>
            <Const TE="'a  b'"/><FiSt/></Statement><NL/><LC TE=" note"/>
            </RootStatements></SCLSource></Network>
            """);
        Assert.Equal("1", body.CompilationUnit);
        Assert.Equal("#text := 'a  b';\n// note", body.Text);
    }

    [Theory]
    [InlineData("<Network Lang='LAD' RefID='1'><RootStatements/></Network>")]
    [InlineData("<Network Lang='SCL' RefID='1'><RootStatements><Unknown/></RootStatements></Network>")]
    [InlineData("<Network Lang='SCL' RefID='1'><RootStatements><Unknown><Const TE='1'/></Unknown></RootStatements></Network>")]
    [InlineData("<Network Lang='SCL' RefID='1'><RootStatements><Const UId='1' TE='1'/><Const UId='1' TE='2'/></RootStatements></Network>")]
    [InlineData("<!DOCTYPE Network [<!ENTITY x SYSTEM 'file:///missing'>]><Network Lang='SCL' RefID='1'><RootStatements>&x;</RootStatements></Network>")]
    public void RefusesUnknownOrAmbiguousNativeBodies(string xml) => Assert.ThrowsAny<Exception>(() => NativeSource.Render(xml));
}
