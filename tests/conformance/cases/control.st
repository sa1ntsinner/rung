(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Control
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    selector : INT := 4;
    i : INT;
    total : INT;
    n : INT;
    (* CASE selects a range. *)
    r_case_range : INT;
    (* CASE selects an explicit list. *)
    r_case_list : INT;
    (* CASE falls back to ELSE. *)
    r_case_else : INT;
    (* FOR walks downward with a negative step. *)
    r_for_negative : INT;
    (* EXIT leaves FOR before its endpoint. *)
    r_for_exit : INT;
    (* CONTINUE skips the rest of a FOR iteration. *)
    r_for_continue : INT;
    (* WHILE tests its condition before each iteration. *)
    r_while : INT;
    (* REPEAT executes once when its condition starts true. *)
    r_repeat : INT;
    (* RETURN in an FC preserves the value already assigned. *)
    r_return_early : INT;
    (* The FC continues after a false RETURN condition. *)
    r_return_normal : INT;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    CASE selector OF
        1..5: r_case_range := 11;
        ELSE r_case_range := 99;
    END_CASE
    CASE selector OF
        1, 4, 7: r_case_list := 22;
        ELSE r_case_list := 99;
    END_CASE
    CASE selector OF
        1, 2: r_case_else := 99;
        ELSE r_case_else := 33;
    END_CASE
    total := 0;
    FOR i := 5 TO -1 BY -2 DO
        total := total + i;
    END_FOR
    r_for_negative := total;
    total := 0;
    FOR i := 1 TO 10 DO
        IF i = 4 THEN EXIT; END_IF
        total := total + i;
    END_FOR
    r_for_exit := total;
    total := 0;
    FOR i := 1 TO 5 DO
        IF i = 3 THEN CONTINUE; END_IF
        total := total + i;
    END_FOR
    r_for_continue := total;
    n := 0;
    WHILE n < 4 DO
        n := n + 1;
    END_WHILE
    r_while := n;
    n := 5;
    REPEAT
        n := n + 1;
    UNTIL n >= 5
    END_REPEAT
    r_repeat := n;
    r_return_early := FC_ConformanceReturn(-3);
    r_return_normal := FC_ConformanceReturn(3);
    done := cycle >= cycles;
END_IF
END_PROGRAM
