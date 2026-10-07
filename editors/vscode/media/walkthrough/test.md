# Run the tests

Tests live in `tests/*.test.yaml` and run on rung's offline simulator: no PLC and no PLCSIM needed.

The Testing view runs them and points a failure at its step. **Run with Coverage** marks in the code which SCL lines the tests reached and which they never did.

Don't know the values to expect yet? Right-click a step with `cycle:` in a test file → **Record Expectations**: the case runs, you pick the values that are right, and they become the step's `expect:`.

Timing is part of a machine's promise: `{ within: 2s, expect: { Motor: true } }`, `always`, `never`.
