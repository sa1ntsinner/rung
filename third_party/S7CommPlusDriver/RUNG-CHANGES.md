# Rung driver changes

Baseline: provided upstream commit `5c84e77`. The original
`LICENSE` and source notices remain; modifications to this library are
LGPL-3.0-or-later. This file accompanies the corresponding fork source.

- `ClientApi/PlcTag.cs`: scalar STRING/WSTRING reads validate their headers and retain PLC-reported capacity. Writes preserve that capacity; public read-only MaxLength allows scalar literal validation. Malformed payloads produce bad quality.
- `ClientApi/Browser.cs`: propagate HMI read-only permissions through containing members so nested tags cannot bypass a parent's write restriction.
- `S7CommPlusCertificateProbe.cs`: classify transport timeouts consistently even when the socket's timer wins the race against cancellation; transport disposal and credential-free inspection are retained.
- `S7CommPlusProtocolSession.cs`: deleting an object drops the notifications still queued under its id. The PLC reuses object ids, so a subscription created right after another one could receive the old one's notifications.
- `S7CommPlusProtocolSession.cs`: retain the one serialized pending request's matching response when an already-active notification reader receives it. Clear the bounded slot on the next request/reset; unrelated responses remain discarded. Idle notification readers yield while a foreground request is pending; that waiter continues routing notifications. This prevents response loss and receive-lock starvation during CPU diagnostics and credit renewals.

- `src/S7CommPlusDriver/S7CommPlusDriver.csproj`: target only `net10.0`, retain
  `S7CommPlusDriver` assembly identity, remove HarpoS7/key packages and its compilation
  switch, native runtime packaging and automatic NuGet packing. Pin existing managed
  dependencies and record their exact resolutions in `packages.lock.json`.
- `S7CommPlusClientOptions.cs`, `S7CommPlusClient.cs`, `S7CommPlusProtocolSession.cs`,
  `S7CommPlusSessionRole.cs`: default and reconnect exclusively through managed TLS;
  reject Auto/LegacyChallenge before creating a transport. Remove challenge settings,
  key discovery, session-key refresh, packet digests, fallback and their test hooks.
  The two old security enum values remain only so callers receive an explicit refusal.
- Delete `S7CommPlusProtocolSession.LegacyChallenge.cs` and `Internal/Legacy*.cs`;
  remove challenge session creation/helpers from `Core/CreateObjectRequest.cs`.
  `Net/S7Consts.cs`, `Core/Ids.cs`: remove obsolete challenge error codes/IDs.
  Remove digest retry classification from `Internal/S7CommPlusErrorClassifier.cs`.
  Ordinary access-level and username/password legitimation over TLS is retained.
  `Legitimation/Legitimation.cs` and `Internal/S7CommPlusErrorClassifier.cs` distinguish
  rejected passwords from read-access denial; the client preserves cancellation.
- `Net/S7Client.cs`: remove native TLS selection, key logging and its now-unnecessary
  native-resource finalizer (and the corresponding reflection test). Delete the native
  `OpenSSL/*.cs` implementation. Native runtime files from the snapshot are retained
  as upstream artifacts but are neither compiled nor copied to outputs.
- `Tls/BouncyCastleTlsConnector.cs`, new `Tls/CertificatePin.cs`: verify the leaf
  certificate SHA-256 pin during TLS authentication, before session creation or
  credentials. Missing, malformed and mismatched pins fail closed. Propagate a
  distinct certificate error code through the transport; TLS remains version 1.3.
- `src/S7CommPlusDriver.Tests`: target `net10.0`, use cached xUnit 2/VSTest dependencies,
  remove HarpoS7 and tests for deleted challenge/native-key-logging/refresh behavior.
  Keep the remaining protocol, transport and fake-session tests; adjust security
  expectations to TLS. Add TLS-only, pin and in-memory TLS handshake tests. Live
  test sources are retained but excluded from the unit-test build so no environment
  setting can make these checks contact a PLC. Remove the obsolete live key option.
- `global.json`: select VSTest for the retained unit-test project.

- `S7CommPlusSubscriptions.cs`: retain the latest startup notification per requested
  tag until a handler attaches, then replay the bounded complete update. This closes
  the interval between subscription creation and host callback registration.

Host integration, probe invocation and packaging requirements are documented in
`bridge/src/Rung.Online/README.md` in the enclosing repository.
