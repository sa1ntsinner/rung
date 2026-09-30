// SPDX-License-Identifier: MIT
// The playground's examples. Each one passes as written; `change` is a one-line edit that makes a case fail
// (a button makes it, and undoes it), `challenge` says what to try.
export const PRESETS = [
  {
    id: "latch",
    label: "Start/stop latch",
    lang: "SCL",
    file: "Fx_Motor.scl",
    challenge: "Remove <code>OR #Running</code> to break the latch, then run again.",
    change: { label: "Break the latch", restore: "Restore the latch", from: "(#Start OR #Running)", to: "#Start" },
    source: `FUNCTION_BLOCK "Fx_Motor"
VAR_INPUT
    Start : Bool;
    Stop : Bool;
END_VAR
VAR_OUTPUT
    Running : Bool;
END_VAR
BEGIN
    #Running := (#Start OR #Running) AND NOT #Stop;
END_FUNCTION_BLOCK
`,
    test: `block: Fx_Motor
cases:
  - name: starts, latches and stops
    steps:
      - set: { Start: true }
      - cycle: 1
      - expect: { Running: true }
      - set: { Start: false }
      - cycle: 1
      - expect: { Running: true }
      - set: { Stop: true }
      - cycle: 1
      - expect: { Running: false }
`,
  },
  {
    id: "timer",
    label: "On-delay timer",
    lang: "SCL",
    file: "Fx_Fan.scl",
    challenge: "Change <code>T#5s</code> to <code>T#3s</code>. Virtual time: the test takes no longer.",
    change: { label: "Shorten the delay", restore: "Restore the delay", from: "T#5s", to: "T#3s" },
    source: `FUNCTION_BLOCK "Fx_Fan"
VAR_INPUT
    Hot : Bool;
END_VAR
VAR_OUTPUT
    Fan : Bool;
END_VAR
VAR
    Delay : TON;
END_VAR
BEGIN
    #Delay(IN := #Hot, PT := T#5s);
    #Fan := #Delay.Q;
END_FUNCTION_BLOCK
`,
    test: `block: Fx_Fan
cycle: 10ms
cases:
  - name: waits five seconds
    steps:
      - set: { Hot: true }
      - advance: 4s
      - expect: { Fan: false }
      - advance: 2s
      - expect: { Fan: true }
  - name: resets when it cools down
    steps:
      - set: { Hot: true }
      - advance: 6s
      - set: { Hot: false }
      - cycle: 1
      - expect: { Fan: false }
`,
  },
  {
    id: "lad",
    label: "LAD interlock",
    lang: "LAD (SIMATIC SD)",
    file: "Fx_LadInterlock.s7dcl",
    challenge: "Delete the <code>Contact( #Guard )</code> line, then run again.",
    change: { label: "Bridge the guard", restore: "Restore the guard", from: "            Contact( #Guard )\n", to: "" },
    source: `{
    S7_Optimized := "TRUE";
    S7_Language := "LAD";
}
FUNCTION "Fx_LadInterlock" : Void
    VAR_INPUT
        Enable : Bool;
        Guard : Bool;
    END_VAR
    VAR_OUTPUT
        Out : Bool;
    END_VAR

    {
      S7_Language := "LAD"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #Enable )
            Contact( #Guard )
            Coil( #Out )
        END_RUNG

    END_NETWORK

END_FUNCTION
`,
    test: `block: Fx_LadInterlock
cases:
  - name: needs both contacts
    steps:
      - { set: { Enable: true, Guard: false }, cycle: 1, expect: { Out: false } }
      - { set: { Enable: true, Guard: true }, cycle: 1, expect: { Out: true } }
      - { set: { Enable: false, Guard: true }, cycle: 1, expect: { Out: false } }
`,
  },
  {
    id: "stl",
    label: "STL logic",
    lang: "STL",
    file: "Fx_Stl.awl",
    challenge: "Change the second <code>A</code> to <code>O</code>, then run again.",
    change: { label: "Turn AND into OR", restore: "Restore AND", from: "      A #B;", to: "      O #B;" },
    source: `FUNCTION "Fx_Stl" : Void
{ S7_Optimized_Access := 'TRUE' }
VERSION : 0.1
   VAR_INPUT
      A : Bool;
      B : Bool;
   END_VAR

   VAR_OUTPUT
      Q : Bool;
   END_VAR


BEGIN
NETWORK
TITLE = AND of two inputs
      A #A;
      A #B;
      = #Q;
END_FUNCTION
`,
    test: `block: Fx_Stl
cases:
  - name: truth table
    steps:
      - { set: { A: false, B: false }, cycle: 1, expect: { Q: false } }
      - { set: { A: true, B: false }, cycle: 1, expect: { Q: false } }
      - { set: { A: false, B: true }, cycle: 1, expect: { Q: false } }
      - { set: { A: true, B: true }, cycle: 1, expect: { Q: true } }
`,
  },
];
