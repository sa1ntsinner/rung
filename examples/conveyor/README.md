# Conveyor: PLC tests without a PLC

One SCL function block, as TIA Portal V20 exports it (it compiles there unchanged), and five tests for it. No TIA Portal, PLCSIM or Windows needed: Node.js 22 or newer is enough.

```sh
cd examples/conveyor
npx -y @rung-plc/cli test
```

```
ok   FB_Conveyor: starts with the button and keeps running after it is released
ok   FB_Conveyor: stops with the stop button and with the emergency stop
ok   FB_Conveyor: a contactor that does not answer within 2 s is a fault until reset
ok   FB_Conveyor: a part waiting at the end stops the belt, taking it away lets it start again
ok   FB_Conveyor: counts every part once

5/5 passed (offline simulation — not a PLCSIM run)
```

Now break it: in [blocks/FB_Conveyor.scl](blocks/FB_Conveyor.scl), take `OR #Fault` out of the line that stops the motor and run the tests again:

```
FAIL FB_Conveyor: a contactor that does not answer within 2 s is a fault until reset
       step 7: Motor expected false got true
```

- [tests/conveyor.test.yaml](tests/conveyor.test.yaml): set inputs, run cycles or virtual time (`advance: 2s`), expect outputs. The format is in [docs/testing.md](../../docs/testing.md).
- [plc.yml](plc.yml): the same tests on every pull request in GitHub Actions; a failing step shows on its line in the pull request. Copy it to `.github/workflows/` in your repository.
- In a real project, `rung pull` mirrors the blocks of your TIA Portal project into files like this one, and the tests sit next to them in `tests/`.
