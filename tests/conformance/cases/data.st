(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Data
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    a : ARRAY[-2..1] OF INT;
    grid : ARRAY[1..2, -1..1] OF INT;
    first : ST_ConformancePair;
    second : ST_ConformancePair;
    state : E_ConformanceState;
    i : INT;
    (* An array accepts a negative lower bound. *)
    r_array_low : INT;
    (* A FOR loop indexes every element across a non-zero lower bound. *)
    r_array_sum : INT;
    (* A multi-dimensional array preserves both lower bounds. *)
    r_grid : INT;
    (* Structure assignment copies members rather than aliasing. *)
    r_struct_number : INT;
    (* Structure assignment copies BOOL members. *)
    r_struct_flag : BOOL;
    (* An enumeration starts at its declared default. *)
    r_enum_default : INT;
    (* An enumeration member qualified by its type selects an explicit value. *)
    r_enum_typed : INT;
    (* CASE matches a qualified enumeration member. *)
    r_enum_case : INT;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    a[-2] := 3;
    a[-1] := 5;
    a[0] := 7;
    a[1] := 11;
    r_array_low := a[-2];
    FOR i := -2 TO 1 DO
        r_array_sum := r_array_sum + a[i];
    END_FOR
    grid[1, -1] := 17;
    grid[2, 1] := 23;
    r_grid := grid[1, -1] + grid[2, 1];
    first.number := 12;
    first.flag := TRUE;
    second := first;
    first.number := 99;
    first.flag := FALSE;
    r_struct_number := second.number;
    r_struct_flag := second.flag;
    r_enum_default := state;
    state := E_ConformanceState.Running;
    r_enum_typed := state;
    CASE state OF
        E_ConformanceState.Running: r_enum_case := 42;
        ELSE r_enum_case := -1;
    END_CASE
    done := cycle >= cycles;
END_IF
END_PROGRAM
