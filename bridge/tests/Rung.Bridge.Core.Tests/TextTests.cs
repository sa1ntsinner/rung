// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Text;
using Rung.Bridge.Core;
using Rung.Bridge.Core.Model;
using Rung.Bridge.Core.Protocol;
using Xunit;

public class TextNormalizerTests
{
    static string N(string s) => Encoding.UTF8.GetString(TextNormalizer.Normalize(Encoding.UTF8.GetBytes(s)));

    [Fact] public void StripsBomAndCrlfAndAddsTrailingLf() => Assert.Equal("a\nb\n", N("﻿a\r\nb"));
    [Fact] public void KeepsEmpty() => Assert.Equal("", N(""));
    [Fact] public void KeepsNonAscii() => Assert.Equal("// Überwachung\n", N("// Überwachung\r\n"));
    [Fact] public void BomIsAddedOnce()
    {
        var once = TextNormalizer.WithBom(Encoding.UTF8.GetBytes("x"));
        Assert.Equal(once, TextNormalizer.WithBom(once));
        Assert.Equal(0xEF, once[0]);
    }
}

public class ProtectedYamlTests
{
    [Fact] public void RendersQuotedFields()
    {
        var y = ProtectedYaml.Render(new ObjectEntry { Address = "plc:P/blocks/A\"B", Kind = "block", BlockType = "FB", Number = 5, Language = "SCL" });
        Assert.Contains("address: \"plc:P/blocks/A\\\"B\"", y);
        Assert.Contains("number: 5", y);
        Assert.Contains("readOnly: true", y);
    }
}

public class FixtureGuardTests
{
    static string Project(bool marker, string content = FixtureGuard.MarkerContent)
    {
        var dir = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "rung-fx-" + Guid.NewGuid().ToString("N"))).FullName;
        if (marker) File.WriteAllText(Path.Combine(dir, FixtureGuard.MarkerName), content);
        return Path.Combine(dir, "RungFixture.ap20");
    }

    [Fact] public void RefusesWithoutFlag() => Assert.Equal("READ_ONLY", Assert.Throws<RpcException>(() => FixtureGuard.Check(false, Project(true))).Code);
    [Fact] public void RefusesWithoutMarker() => Assert.Equal("READ_ONLY", Assert.Throws<RpcException>(() => FixtureGuard.Check(true, Project(false))).Code);
    [Fact] public void RefusesWrongMarker() => Assert.Throws<RpcException>(() => FixtureGuard.Check(true, Project(true, "something else")));
    [Fact] public void AllowsMarkedFixture() => FixtureGuard.Check(true, Project(true));
}
