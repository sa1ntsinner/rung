using System;
using System.Threading;
using System.Threading.Tasks;
using System.Collections.Generic;
using Xunit;

namespace S7CommPlusDriver.Tests;

public sealed class TlsOnlyTests
{
    [Fact]
    public void DefaultIsTls() => Assert.Equal(S7CommPlusSecurityMode.Tls, new S7CommPlusClientOptions().SecurityMode);

    [Fact]
    public void AssemblyHasNoChallengeDependenciesOrImplementation()
    {
        var assembly = typeof(S7CommPlusClient).Assembly;
        Assert.DoesNotContain(assembly.GetReferencedAssemblies(), name => name.Name!.StartsWith("Harpo", StringComparison.Ordinal));
        Assert.DoesNotContain(assembly.GetTypes(), type => type.FullName!.Contains("LegacyChallenge", StringComparison.Ordinal) ||
            type.FullName.Contains("OpenSsl", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(S7CommPlusSecurityMode.Auto)]
    [InlineData(S7CommPlusSecurityMode.LegacyChallenge)]
    public void UnsupportedModeNeverCreatesSession(S7CommPlusSecurityMode mode)
    {
        var created = false;
        Assert.Throws<S7CommPlusUnsupportedSecurityModeException>(() => new S7CommPlusClient(
            new S7CommPlusClientOptions { Address = "127.0.0.1", SecurityMode = mode },
            () => { created = true; return new FakeS7CommPlusSession(); }));
        Assert.False(created);
    }

    [Fact]
    public async Task CancellationDuringDriverConnectRemainsCancellation()
    {
        using var started = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var cancellation = new CancellationTokenSource();
        var fake = new FakeS7CommPlusSession { ConnectHandler = _ => { started.Set(); release.Wait(); return 0; } };
        await using var client = new S7CommPlusClient(new S7CommPlusClientOptions { Address = "127.0.0.1" }, () => fake);
        var pending = client.ConnectAsync(cancellation.Token);
        Assert.True(started.Wait(TimeSpan.FromSeconds(2)));
        cancellation.Cancel();
        try { await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending); }
        finally { release.Set(); }
    }

    [Fact]
    public async Task ConnectPasswordRejectionIsTypedLegitimationError()
    {
        var fake = new FakeS7CommPlusSession { ConnectHandler = _ => S7Consts.errCliInvalidPassword };
        await using var client = new S7CommPlusClient(new S7CommPlusClientOptions { Address = "127.0.0.1" }, () => fake);
        await Assert.ThrowsAsync<S7CommPlusLegitimationException>(() => client.ConnectAsync());
    }

    [Fact]
    public async Task ReconnectKeepsTlsPinAndOrdinaryPassword()
    {
        var pin = new string('a', 64);
        var fake = new FakeS7CommPlusSession
        {
            ConnectHandler = options =>
            {
                Assert.Equal(S7CommPlusSecurityMode.Tls, options.SecurityMode);
                Assert.Equal(S7CommPlusTlsBackend.BouncyCastle, options.TlsBackend);
                Assert.Equal(pin, options.CertificateSha256);
                Assert.Equal("password", options.Password);
                return 0;
            }
        };
        fake.ReadHandler = _ => fake.ReadCount == 1
            ? (S7Consts.errTCPDataReceive, new List<object?>(), new List<ulong>())
            : (0, new List<object?> { new ValueInt(7) }, new List<ulong> { 0 });
        await using var client = new S7CommPlusClient(new S7CommPlusClientOptions
        { Address = "127.0.0.1", CertificateSha256 = pin, Password = "password" }, () => fake);
        Assert.True((await client.ReadAsync(new[] { new ItemAddress("8A0E0001.F") })).Items[0].IsSuccess);
        Assert.Equal(2, fake.ConnectCount);
    }
}
