---
name: lad-in-text
description: Use when reading, changing or creating LAD (ladder) blocks in a rung workspace, i.e. .s7dcl/.s7res files in SIMATIC SD text, or when a person asks for ladder logic rather than SCL.
---

# LAD as text (SIMATIC SD)

A LAD block is mirrored as `<Name>.s7dcl` (declaration and networks) plus `<Name>.s7res` (texts). rung imports it like any other file: edit, `rung_sync`, read the diagnostics. TIA rewrites the file in its canonical layout (blank lines around networks); re-read it before further edits.

Write SCL unless the person or the house style wants LAD. Never convert an existing LAD block to SCL (or back) on your own.

## When the file is `.xml` instead

rung keeps a LAD block as SimaticML `.xml` whenever SD would lose something: network titles or comments (TIA Portal V20 before Update 4 writes no texts into SD), a non-cycle OB (SD drops the OB type), STL or mixed-language networks. Do not hand-edit FlgNet XML; propose the change to the person, or, if they agree, rewrite the logic as a new SCL block.

## Shape of a file

```
{
    S7_Optimized := "TRUE";
    S7_Language := "LAD";
}
FUNCTION_BLOCK "FB_Pump"
    VAR_INPUT
        Start : Bool;
        Stop : Bool;
        Pressure : Real;
    END_VAR
    VAR_OUTPUT
        Run : Bool;
    END_VAR
    VAR
        {
             InstructionName := "TON_TIME";
             LibVersion := "1.0";
             S7_Setpoint := "False"
        }
        StartDelay : TON_TIME;
    END_VAR

    {
      S7_Language := "LAD"
    }
    NETWORK
        RUNG wire#powerrail
            Contact( #Start )
            Coil( #Run )
        END_RUNG

    END_NETWORK

END_FUNCTION_BLOCK
```

The declaration part is the same as in SCL. Every network starts with its `{ S7_Language := "LAD" }` pragma. A `RUNG` starts at the power rail (`wire#powerrail`) and lists its elements left to right; power flows through them in order.

## Elements (verified on TIA Portal V20)

| LAD | SD text |
|---|---|
| normally open contact | `Contact( #Start )` |
| normally closed contact | `I_Contact( #Stop )` |
| coil | `Coil( #Run )` |
| set / reset coil | `S_Coil( #Alarm )` / `R_Coil( #Alarm )` |
| timer in a multi-instance | `#StartDelay.TON{ time_type := Time }( PT := T#3S, ET => )`, input IN is the power flow, output Q continues the rung |
| comparison | `Gt{ SrcType := Real }( IN1 := #Pressure, IN2 := 6.5 )` (also `Lt`, `Ge`, `Le`, `Eq`, `Ne`) |
| move | `Move{ Card := 1; DisableENO := TRUE }( IN := 1, OUT1 => #Level )` |

Operands are written as in SCL: `#Local`, `"DB_Name".Member`, `%I0.0`, literals `T#3S`, `6.5`. Unused box outputs stay in the list with nothing after `=>` (`ET =>`).

## Parallel branches (OR)

A branch is a second rung that ends at a named wire; the main rung passes through that wire:

```
        RUNG wire#powerrail
            Contact( #Start )
            wire#w1
            I_Contact( #Stop )
            Coil( #Run )
        END_RUNG
        RUNG wire#powerrail
            Contact( #Run )
        END_RUNG wire#w1
```

reads `Run := (Start OR Run) AND NOT Stop`: at `wire#w1` the flow of `Contact( #Start )` and the flow of the branch rung are joined. Number wires `w1`, `w2`, … per network. Several independent rungs in one network (a set and a reset rung, for example) each start at `wire#powerrail`.

## Habits

- One job per network, as in TIA: the latch, the timer, the alarm each get their own `NETWORK`.
- Keep the operand order that the person's existing networks use; LAD readers scan left to right.
- After `rung_sync`, a compile error points at the file; LAD errors often name the network, count `NETWORK` keywords to find it.
- Test the block like an SCL block (`plc-testing`); say which parts you could not verify offline.
