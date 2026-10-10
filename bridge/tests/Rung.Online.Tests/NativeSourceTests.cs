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
        Assert.Empty(NativeSource.RootCallSites(debug, [body], [references], "Other_DB"));
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
        var binding = Assert.Single(NativeSource.Scalars(Debug(256, 32), ScalarBody));
        Assert.Equal(new NativeScalar("COUNT", 32, 32, "{Scalar\"33554439\"DInt}"), binding);
        var temporary = Debug(256, 32).Replace("</LanguageElement>", "<MonitoringElement type='{Scalar&amp;quot;33554439&amp;quot;DInt}' debugValueRef='4'/></LanguageElement>")
            .Replace("</Monitoring>", "<DebugValue id='4' bitSize='32'><Addr><Native scope='NativeLocal' location='Slot32' locationNumber='0'/></Addr></DebugValue></Monitoring>");
        Assert.Equal(binding, Assert.Single(NativeSource.Scalars(temporary, ScalarBody)));
        Assert.ThrowsAny<Exception>(() => NativeSource.Scalars(Debug(256, 32).Replace("cuId=\"1\"", "cuId=\"2\""), ScalarBody));
        Assert.ThrowsAny<Exception>(() => NativeSource.Scalars(Debug(256, 32).Replace("granted=\"true\"", "granted=\"false\""), ScalarBody));
        Assert.ThrowsAny<Exception>(() => NativeSource.Scalars(Debug(256, 32).Replace("elementId=\"7\"", "elementId=\"8\""), ScalarBody));
    }

    const string TwoBody = "<Network Lang='SCL' RefID='1'><RootStatements><SymVa UId='7' ODN='#Count'/><SymVa UId='8' ODN='#Other'/></RootStatements></Network>";
    static string Two(uint first, uint second) => $$"""
        <DebugInfo><Monitoring>
        <LanguageElement cuId="1" elementId="7"><MonitoringElement type="{Scalar&quot;33554439&quot;DInt}" debugValueRef="3"/></LanguageElement>
        <LanguageElement cuId="1" elementId="8"><MonitoringElement type="{Scalar&quot;33554439&quot;DInt}" debugValueRef="5"/></LanguageElement>
        <DebugValue id="3" bitSize="32"><Indirect typeSafe="true" granted="true" pointerScope="NativeBlock" pointerNumber="{{first}}" bitOffset="32"/></DebugValue>
        <DebugValue id="5" bitSize="32"><Indirect typeSafe="true" granted="true" pointerScope="NativeBlock" pointerNumber="{{second}}" bitOffset="64"/></DebugValue>
        </Monitoring></DebugInfo>
        """;

    // as TIA Portal V20 writes #s.a := 1; #arr[1] := 2; (seen live): the member is monitored alone, the element whole
    const string CompositeBody = "<Network Lang='SCL' RefID='1'><RootStatements>"
        + "<Statement UId='48'><Expression UId='65' SI='ExprDot'><Expression UId='62' SI='ExprPrimD'><SymVa UId='31' SI='VarStruct' ODN='#s'/></Expression><Dot UId='32'/><SymVa UId='34' SI='Var' ODN='a'/></Expression></Statement>"
        + "<Statement UId='159'><Expression UId='161' SI='ExprInd'><Expression UId='162' SI='ExprPrimD'><SymVa UId='154' SI='VarArray' ODN='#arr'/></Expression><BoxO UId='155'/><Expression UId='164' SI='ExprPrimC'><Const TE='1' UId='156'/></Expression><BoxC UId='157'/><SymVa UId='165' SI='VarElem' ODN='' Deco='ArrayElement§7'/></Expression></Statement>"
        + "</RootStatements></Network>";
    static string CompositeDebug(string arrayElement = "161") => $$"""
        <DebugInfo><Monitoring>
        <LanguageElement cuId="1" elementId="34"><MonitoringElement type="{Scalar&quot;33554437&quot;Int}" debugValueRef="3"/></LanguageElement>
        <LanguageElement cuId="1" elementId="{{arrayElement}}"><MonitoringElement type="{Scalar&quot;33554437&quot;Int}" debugValueRef="5"/></LanguageElement>
        <DebugValue id="3" bitSize="16"><Indirect typeSafe="true" granted="true" pointerScope="NativeBlock" pointerNumber="4" bitOffset="48"/></DebugValue>
        <DebugValue id="5" bitSize="16"><Indirect typeSafe="true" granted="true" pointerScope="NativeBlock" pointerNumber="4" bitOffset="96"/></DebugValue>
        </Monitoring></DebugInfo>
        """;

    [Fact]
    public void NamesAStructureMemberAndAConstantArrayElementByTheirWholePath()
    {
        var bindings = NativeSource.Scalars(CompositeDebug(), CompositeBody);
        Assert.Equal(new[] { "S.A", "ARR[1]" }, bindings.Select(b => b.Name).ToArray());
        Assert.Equal(new uint[] { 48, 96 }, bindings.Select(b => b.BitOffset).ToArray());
        // what is no path (here the index expression) binds nothing: a computed element stays uncaptured
        Assert.Equal(new[] { "S.A" }, NativeSource.Scalars(CompositeDebug("164"), CompositeBody).Select(b => b.Name).ToArray());
    }

    [Fact]
    public void ReadsTheValueOfALocalConstantTheCompiledCodeUses()
    {
        // #Count := #next MOD #LIMIT; with LIMIT : Int := 1000 (seen live: the debug info holds the compiled value)
        var body = "<Network Lang='SCL' RefID='1'><RootStatements><Statement UId='1'><SymVa UId='118' SI='ConstInt' SyId='6' ODN='#LIMIT' /></Statement></RootStatements></Network>";
        var debug = "<DebugInfo><Monitoring><LanguageElement cuId='1' elementId='118'><MonitoringElement key='InValue' type='{Scalar&quot;33554437&quot;Int}' debugValueRef='4' /></LanguageElement>"
            + "<DebugValue id='4' bitSize='16' type='IsSimple'><Addr sac='31'><Immediate value='1000' /></Addr></DebugValue></Monitoring></DebugInfo>";
        Assert.Equal(new[] { new NativeConstant("LIMIT", "{Scalar\"33554437\"Int}", "1000") }, NativeSource.Constants(debug, body));
    }

    [Fact]
    public void ListsTheUserFcsACodeBlockCalls()
    {
        // seen live: FB_ProveFc calls "FC_ProveAdd" (FC 5); its interface ident repeats the call hidden
        var refs = "<?xml version='1.0' encoding='utf-8'?><IdentContainer><Ident Name='FC_ProveAdd' Scope='Global' RefId='3'><CrossRefInfo><XRefItem UId='143' Usage='Call' NetId='1' /></CrossRefInfo>"
            + "<Access><FCBlock BlockNumber='5' BlockType='FC' Type='Block_FC' TypeName='FC_ProveAdd' /></Access></Ident>"
            + "<Ident Name='_x0023_Count' Scope='Local' RefId='1'><CrossRefInfo><XRefItem UId='28' Usage='Write' NetId='1' /></CrossRefInfo><Access><InterfaceAccess AbsOffset='48' Type='Int' /></Access></Ident>"
            + "<Ident Name='Fx_Global' Scope='Global' RefId='6'><CrossRefInfo><XRefItem UId='60' Usage='Read' NetId='1' /></CrossRefInfo><Access><DBBlock BlockNumber='2' /></Access></Ident></IdentContainer>";
        Assert.Equal(new uint[] { 5 }, NativeSource.CalledFunctions([refs]));
        Assert.Empty(NativeSource.CalledFunctions([]));
        var fbRefs = refs.Replace("FCBlock BlockNumber='5' BlockType='FC'", "FBBlock BlockNumber='19' BlockType='FB'");
        Assert.Equal(new uint[] { 19 }, NativeSource.CalledFunctionBlocks([fbRefs]));
        Assert.Empty(NativeSource.CalledFunctionBlocks([refs]));
    }

    [Fact]
    public void ABlockThatDoesNotCallTheInstanceHasNoCallSites()
    {
        var body = "<Network Lang='SCL' RefID='1'><RootStatements><Statement UId='1'><SymVa UId='2' SI='Var' ODN='#x' /></Statement></RootStatements></Network>";
        Assert.Empty(NativeSource.RootCallSites("<DebugInfo />", [body], [], "Motor_DB"));
    }

    [Fact]
    public void FindsAMultiInstanceCallAndTheFbItCallsInTheCallersCode()
    {
        // as FB_ProveMath calls #inner (seen live, TIA Portal V20)
        var body = "<Network Lang='SCL' RefID='1'><RootStatements><Statement UId='1014' SI='STSub'><InstCa UId='1019'><Sub UId='1018' SI='FB' SyId='85' ODN='#inner' /><BracO UId='1012' /><BracC UId='1026' /></InstCa></Statement></RootStatements></Network>";
        var debug = "<DebugInfo><Operand sac='422' index='0' cuId='1' elementId='1018' /><Operand sac='452' index='0' cuId='1' elementId='1018' /><Operand sac='9' cuId='1' elementId='77' /></DebugInfo>";
        var references = "<IdentContainer><Ident Name='FB_ProveInner' Scope='Global' RefId='31'><CrossRefInfo><XRefItem UId='1018' Usage='Call' NetId='1' Name='#inner' /></CrossRefInfo><Access><FBBlock BlockNumber='9' BlockType='FB' TypeName='FB_ProveInner' /></Access></Ident></IdentContainer>";
        var site = NativeSource.MemberCallSites(debug, [body], [references], "inner");
        Assert.Equal(9u, site.Callee);
        Assert.Equal(new uint[] { 422, 452 }, site.Sacs);
        Assert.Throws<NotSupportedException>(() => NativeSource.MemberCallSites(debug, [body], [references], "other"));
    }

    [Fact]
    public void TheCallAtAStackFrameSacNamesTheFbItCalls()
    {
        var body = "<Network Lang='SCL' RefID='1'><RootStatements><Statement UId='1014' SI='STSub'><InstCa UId='1019'><Sub UId='1018' SI='FB' SyId='85' ODN='#inner' /><BracO UId='1012' /><BracC UId='1026' /></InstCa></Statement><Statement UId='70'><SymVa UId='77' SI='Var' ODN='#x' /></Statement></RootStatements></Network>";
        var debug = "<DebugInfo><Operand sac='422' index='0' cuId='1' elementId='1018' /><Operand sac='9' cuId='1' elementId='77' /></DebugInfo>";
        var references = "<IdentContainer><Ident Name='FB_ProveInner' Scope='Global' RefId='31'><CrossRefInfo><XRefItem UId='1018' Usage='Call' NetId='1' Name='#inner' /></CrossRefInfo><Access><FBBlock BlockNumber='9' BlockType='FB' TypeName='FB_ProveInner' /></Access></Ident></IdentContainer>";
        Assert.Equal(9u, NativeSource.CalleeAt(debug, [body], [references], 422));
        // a SAC on something else than an FB call
        Assert.Throws<NotSupportedException>(() => NativeSource.CalleeAt(debug, [body], [references], 9));
        Assert.ThrowsAny<Exception>(() => NativeSource.CalleeAt(debug, [body], [references], 5));
    }

    [Fact]
    public void InstanceMembersShareOneNativePointerWhateverTheBlockNumbers()
    {
        Assert.Equal(2, NativeSource.Scalars(Two(4, 4), TwoBody).Length);
        Assert.Contains("pointer 5", Assert.ThrowsAny<NotSupportedException>(() => NativeSource.Scalars(Two(4, 5), TwoBody)).Message);
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
