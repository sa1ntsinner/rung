// SPDX-License-Identifier: BUSL-1.1
using Rung.Online;
using S7CommPlusDriver;
using System.Security.Authentication;
using Xunit;

namespace Rung.Online.Tests;

public sealed class ProbeCommandTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ParsesProbe(bool password)
    {
        var args = new List<string> { "probe", "--address", "192.168.250.1" };
        if (password) args.Insert(1, "--password-stdin");
        Assert.Equal(new ProbeOptions("192.168.250.1", password), ProbeOptions.Parse(args.ToArray()));
    }

    [Theory]
    [InlineData("")]
    [InlineData("probe")]
    [InlineData("read --address 192.168.250.1")]
    [InlineData("probe --address")]
    [InlineData("probe --address localhost")]
    [InlineData("probe --address 192.168.250.001")]
    [InlineData("probe --address ::ffff:192.168.250.1")]
    [InlineData("probe --address 192.168.250.1 --unknown")]
    [InlineData("probe --address 192.168.250.1 --address 192.168.250.2")]
    [InlineData("probe --address 192.168.250.1 --password-stdin --password-stdin")]
    [InlineData("probe --address 192.168.250.1 --show-certificate --show-certificate")]
    public void RejectsMalformedArguments(string command) =>
        Assert.Throws<ArgumentException>(() => ProbeOptions.Parse(command.Split(' ', StringSplitOptions.RemoveEmptyEntries)));

    [Theory]
    [InlineData("probe --address 192.168.1.1")]
    [InlineData("probe --address 192.168.250.1 --address 192.168.1.1")]
    [InlineData("--help --address=192.168.1.1")]
    [InlineData("bad 192.168.1.1 --password-stdin")]
    [InlineData("probe --address 192.168.001.001")]
    [InlineData("probe --address ::ffff:192.168.1.1")]
    [InlineData("probe --show-certificate --address 192.168.1.1")]
    public async Task RefusesProtectedAddressBeforeInputTrustOrTransport(string command)
    {
        using var error = new StringWriter();
        var calls = 0;
        var result = await ProbeCommand.RunAsync(command.Split(' '), new UnreadableInput(), TextWriter.Null, error,
            () => throw new Exception("Trust must not be consulted"),
            (_, _, _, _) => { calls++; return Task.CompletedTask; });
        Assert.Equal(3, result);
        Assert.Contains("TARGET_REFUSED", error.ToString());
        Assert.Equal(0, calls);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("00")]
    [InlineData("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")]
    public async Task UnknownPinInspectsCertificateBeforePasswordOrSession(string? pin)
    {
        using var error = new StringWriter();
        var calls = 0;
        var result = await ProbeCommand.RunAsync(new[] { "probe", "--address", "192.168.250.1", "--password-stdin" },
            new UnreadableInput(), TextWriter.Null, error, () => pin,
            (_, _, _, _) => { calls++; return Task.CompletedTask; },
            inspect: (_, _) => Task.FromResult<byte[]?>(null));
        Assert.Equal(4, result);
        Assert.Contains("CERTIFICATE_UNTRUSTED", error.ToString());
        Assert.Contains("No certificate was presented", error.ToString());
        Assert.Equal(0, calls);
    }

    [Fact]
    public async Task ShowCertificateDoesNotConsultPinReadPasswordOrStartSession()
    {
        using var output = new StringWriter();
        var inspections = 0;
        var result = await ProbeCommand.RunAsync(
            new[] { "probe", "--address", "192.168.250.1", "--show-certificate", "--password-stdin" },
            new UnreadableInput(), output, TextWriter.Null,
            () => throw new Exception("Pin must not be consulted"),
            (_, _, _, _) => throw new Exception("Session must not be started"),
            inspect: (options, _) =>
            {
                Assert.Equal("192.168.250.1", options.Address);
                inspections++;
                return Task.FromResult<byte[]?>(null);
            });
        Assert.Equal(6, result);
        Assert.Equal(1, inspections);
        Assert.Contains("No certificate was presented", output.ToString());
        Assert.Contains("secure PG/PC", output.ToString());
        Assert.Contains("older firmware", output.ToString());
    }

    [Fact]
    public async Task ReadsOnlyOnePasswordLineAndPassesTlsPin()
    {
        var pin = new string('a', 64);
        using var input = new StringReader("secret\nunused\n");
        var calls = 0;
        var result = await ProbeCommand.RunAsync(new[] { "probe", "--address", "192.168.250.1", "--password-stdin" },
            input, TextWriter.Null, TextWriter.Null, () => pin, (options, password, certificate, _) =>
            {
                Assert.Equal("192.168.250.1", options.Address);
                Assert.Equal("secret", password);
                Assert.Equal(pin, certificate);
                calls++;
                return Task.CompletedTask;
            });
        Assert.Equal(0, result);
        Assert.Equal(1, calls);
        Assert.Equal("unused", input.ReadLine());
    }

    [Fact]
    public async Task NoPasswordOptionNeverReadsInput()
    {
        var calls = 0;
        Assert.Equal(0, await ProbeCommand.RunAsync(new[] { "probe", "--address", "192.168.250.1" },
            new UnreadableInput(), TextWriter.Null, TextWriter.Null, () => new string('0', 64),
            (_, password, _, _) => { Assert.Equal("", password); calls++; return Task.CompletedTask; }));
        Assert.Equal(1, calls);
    }

    [Fact]
    public async Task ErrorOutputNeverIncludesPasswordOrRawException()
    {
        using var error = new StringWriter();
        Assert.Equal(5, await ProbeCommand.RunAsync(new[] { "probe", "--address", "192.168.250.1", "--password-stdin" },
            new StringReader("secret"), TextWriter.Null, error, () => new string('0', 64),
            (_, _, _, _) => throw new S7CommPlusLegitimationException("Connect", "endpoint", 1, false, "secret")));
        Assert.Contains("AUTHENTICATION_FAILED", error.ToString());
        Assert.DoesNotContain("secret", error.ToString());
    }

    [Theory]
    [InlineData("certificate", 4, "CERTIFICATE_UNTRUSTED")]
    [InlineData("tls", 6, "TLS_FAILED")]
    [InlineData("auth", 5, "AUTHENTICATION_FAILED")]
    [InlineData("password", 5, "AUTHENTICATION_FAILED")]
    [InlineData("password-required", 5, "AUTHENTICATION_FAILED")]
    [InlineData("pin", 4, "CERTIFICATE_UNTRUSTED")]
    [InlineData("timeout", 7, "TIMEOUT")]
    [InlineData("cancel", 7, "TIMEOUT")]
    [InlineData("connection", 8, "CONNECTION_FAILED")]
    [InlineData("access", 9, "ACCESS_DENIED")]
    [InlineData("unexpected", 1, "FAILED")]
    public void MapsErrors(string kind, int exit, string code)
    {
        Exception exception = kind switch
        {
            "certificate" => new AuthenticationException("untrusted"),
            "tls" => new S7CommPlusConnectionException("Connect", "endpoint", S7Consts.errOpenSSL, false, "tls"),
            "auth" => new S7CommPlusLegitimationException("Connect", "endpoint", 1, false, "auth"),
            "password" => new S7CommPlusConnectionException("Connect", "endpoint", S7Consts.errCliInvalidPassword, false, "password"),
            "password-required" => new S7CommPlusConnectionException("Connect", "endpoint", S7Consts.errCliNeedPassword, false, "password"),
            "pin" => new S7CommPlusConnectionException("Connect", "endpoint", S7Consts.errS7CommPlusCertificate, false, "pin"),
            "timeout" => new S7CommPlusTimeoutException("Read", "endpoint", 1, "timeout"),
            "cancel" => new OperationCanceledException(),
            "connection" => new S7CommPlusConnectionException("Connect", "endpoint", 1, true, "connection"),
            "access" => new S7CommPlusConnectionException("Read", "endpoint", S7Consts.errCliAccessDenied, false, "access"),
            _ => new Exception("secret")
        };
        Assert.Equal(exit, ProbeError.From(exception).ExitCode);
        Assert.Equal(code, ProbeError.From(exception).Code);
    }

    [Fact]
    public async Task PasswordEofIsUsageErrorBeforeTransport()
    {
        var calls = 0;
        Assert.Equal(2, await ProbeCommand.RunAsync(new[] { "probe", "--address", "192.168.250.1", "--password-stdin" },
            new StringReader(""), TextWriter.Null, TextWriter.Null, () => new string('0', 64),
            (_, _, _, _) => { calls++; return Task.CompletedTask; }));
        Assert.Equal(0, calls);
    }

    private sealed class UnreadableInput : TextReader
    {
        public override ValueTask<string?> ReadLineAsync(CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Input must not be read");
    }
}
