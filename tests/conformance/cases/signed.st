(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Signed
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    sint_max : SINT := 127;
    sint_min : SINT := -128;
    int_max : INT := 32767;
    int_min : INT := -32768;
    dint_max : DINT := 2147483647;
    dint_min : DINT := -2147483648;
    dividend : INT := -7;
    divisor : INT := 3;
    small : SINT := 120;
    wider : DINT := 40000;
    (* SINT maximum plus one wraps on assignment. *)
    r_sint_overflow : SINT;
    (* SINT minimum minus one wraps on assignment. *)
    r_sint_underflow : SINT;
    (* SINT multiplication truncates to its destination width. *)
    r_sint_mul : SINT;
    (* INT maximum plus one wraps on assignment. *)
    r_int_overflow : INT;
    (* INT minimum minus one wraps on assignment. *)
    r_int_underflow : INT;
    (* INT multiplication truncates to its destination width. *)
    r_int_mul : INT;
    (* DINT maximum plus one wraps on assignment. *)
    r_dint_overflow : DINT;
    (* DINT minimum minus one wraps on assignment. *)
    r_dint_underflow : DINT;
    (* DINT multiplication truncates to its destination width. *)
    r_dint_mul : DINT;
    (* Integer division of a negative dividend truncates toward zero. *)
    r_div_negative : INT;
    (* A negative divisor reverses the quotient sign. *)
    r_div_negative_divisor : INT;
    (* MOD with a negative dividend. *)
    r_mod_negative : INT;
    (* MOD with a negative divisor. *)
    r_mod_negative_divisor : INT;
    (* Mixed SINT and DINT arithmetic widens before assignment. *)
    r_mixed_widen : DINT;
    (* An INT sum assigned to DINT exposes native intermediate width. *)
    r_intermediate : DINT;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_sint_overflow := sint_max + SINT#1;
    r_sint_underflow := sint_min - SINT#1;
    r_sint_mul := sint_max * SINT#2;
    r_int_overflow := int_max + INT#1;
    r_int_underflow := int_min - INT#1;
    r_int_mul := int_max * INT#2;
    r_dint_overflow := dint_max + DINT#1;
    r_dint_underflow := dint_min - DINT#1;
    r_dint_mul := dint_max * DINT#2;
    r_div_negative := dividend / divisor;
    r_div_negative_divisor := dividend / -divisor;
    r_mod_negative := dividend MOD divisor;
    r_mod_negative_divisor := INT#7 MOD -divisor;
    r_mixed_widen := small + wider;
    r_intermediate := int_max + INT#1;
    done := cycle >= cycles;
END_IF
END_PROGRAM
