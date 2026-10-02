(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_SelectionMath
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    low : INT := -3;
    high : INT := 7;
    value : INT := 12;
    root : REAL := 2.0;
    base : LREAL := 2.0;
    (* Comparison of signed integers. *)
    r_less : BOOL;
    (* Equality of unequal values. *)
    r_equal : BOOL;
    (* Mixed REAL and LREAL comparison. *)
    r_real_cmp : BOOL;
    (* SEL false selects its first value. *)
    r_sel_false : INT;
    (* SEL true selects its second value. *)
    r_sel_true : INT;
    (* MUX zero selects the first value. *)
    r_mux_first : INT;
    (* MUX selects the last valid value. *)
    r_mux_last : INT;
    (* LIMIT clamps above the maximum. *)
    r_limit_high : INT;
    (* LIMIT clamps below the minimum. *)
    r_limit_low : INT;
    (* LIMIT preserves a value inside its bounds. *)
    r_limit_inside : INT;
    (* MIN accepts multiple operands. *)
    r_min : INT;
    (* MAX accepts multiple operands. *)
    r_max : INT;
    (* ABS of a negative INT. *)
    r_abs : INT;
    (* SQRT of a non-square REAL. *)
    r_sqrt : REAL;
    (* EXPT of an LREAL base. *)
    r_expt : LREAL;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_less := low < high;
    r_equal := value = high;
    r_real_cmp := REAL#1.5 < LREAL#1.75;
    r_sel_false := SEL(FALSE, low, high);
    r_sel_true := SEL(TRUE, low, high);
    r_mux_first := MUX(0, low, high, value);
    r_mux_last := MUX(2, low, high, value);
    r_limit_high := LIMIT(low, value, high);
    r_limit_low := LIMIT(low, INT#-10, high);
    r_limit_inside := LIMIT(low, INT#2, high);
    r_min := MIN(value, low, high);
    r_max := MAX(value, low, high);
    r_abs := ABS(low);
    r_sqrt := SQRT(root);
    r_expt := EXPT(base, LREAL#3.0);
    done := cycle >= cycles;
END_IF
END_PROGRAM
