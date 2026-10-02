(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Time
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    one : TIME := T#1S;
    half : TIME := T#500MS;
    compound : TIME := T#1M2S3MS;
    (* TIME addition of seconds and milliseconds. *)
    r_add : TIME;
    (* TIME subtraction with a positive result. *)
    r_sub : TIME;
    (* Equivalent TIME literals compare equal. *)
    r_equal : BOOL;
    (* TIME ordering compares durations. *)
    r_less : BOOL;
    (* A compound TIME literal preserves milliseconds. *)
    r_compound : TIME;
    (* TIME to UDINT uses milliseconds. *)
    r_milliseconds : UDINT;
    (* MIN selects the shorter duration. *)
    r_min : TIME;
    (* LIMIT clamps a TIME duration. *)
    r_limit : TIME;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_add := one + half;
    r_sub := one - half;
    r_equal := one + half = T#1500MS;
    r_less := half < one;
    r_compound := compound;
    r_milliseconds := TIME_TO_UDINT(compound);
    r_min := MIN(one, half);
    r_limit := LIMIT(half, T#2S, one);
    done := cycle >= cycles;
END_IF
END_PROGRAM
