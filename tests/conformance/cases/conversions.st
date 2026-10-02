(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Conversions
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    p_half : REAL := 0.5;
    p_one_half : REAL := 1.5;
    p_two_half : REAL := 2.5;
    n_half : REAL := -0.5;
    n_one_half : REAL := -1.5;
    n_two_half : REAL := -2.5;
    negative : REAL := -2.9;
    lp_half : LREAL := 2.5;
    ln_half : LREAL := -2.5;
    large : DINT := 16777217;
    integer : INT := -123;
    decimal_text : STRING := '-123';
    real_text : STRING := '12.5';
    typed_text : STRING := '16#FF';
    (* REAL_TO_INT at positive one half. *)
    r_half : INT;
    (* REAL_TO_INT at positive one and a half. *)
    r_one_half : INT;
    (* REAL_TO_INT at positive two and a half. *)
    r_two_half : INT;
    (* REAL_TO_INT at negative one half. *)
    r_neg_half : INT;
    (* REAL_TO_INT at negative one and a half. *)
    r_neg_one_half : INT;
    (* REAL_TO_INT at negative two and a half. *)
    r_neg_two_half : INT;
    (* LREAL_TO_DINT at a positive tie. *)
    r_lreal_half : DINT;
    (* LREAL_TO_DINT at a negative tie. *)
    r_lreal_neg_half : DINT;
    (* TRUNC discards a negative fractional part. *)
    r_trunc_neg : DINT;
    (* TRUNC at a positive rounding tie. *)
    r_trunc_tie : DINT;
    (* A negative INT converts to REAL. *)
    r_int_real : REAL;
    (* REAL loses the low bit beyond its 24-bit significand. *)
    r_real_precision : REAL;
    (* TRUE converts to one. *)
    r_bool_true : INT;
    (* FALSE converts to zero. *)
    r_bool_false : INT;
    (* Signed decimal STRING to INT. *)
    r_string_int : INT;
    (* Decimal STRING to REAL. *)
    r_string_real : REAL;
    (* Radix-prefixed STRING to UINT. *)
    r_string_hex : UINT;
    (* INT to signed decimal STRING. *)
    r_int_string : STRING;
    (* BOOL to STRING spelling. *)
    r_bool_string : STRING;
    (* REAL intermediate rounding is visible after cancellation. *)
    r_real_cancel : REAL;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_half := REAL_TO_INT(p_half);
    r_one_half := REAL_TO_INT(p_one_half);
    r_two_half := REAL_TO_INT(p_two_half);
    r_neg_half := REAL_TO_INT(n_half);
    r_neg_one_half := REAL_TO_INT(n_one_half);
    r_neg_two_half := REAL_TO_INT(n_two_half);
    r_lreal_half := LREAL_TO_DINT(lp_half);
    r_lreal_neg_half := LREAL_TO_DINT(ln_half);
    r_trunc_neg := TRUNC(negative);
    r_trunc_tie := TRUNC(p_two_half);
    r_int_real := INT_TO_REAL(integer);
    r_real_precision := DINT_TO_REAL(large);
    r_bool_true := BOOL_TO_INT(TRUE);
    r_bool_false := BOOL_TO_INT(FALSE);
    r_string_int := STRING_TO_INT(decimal_text);
    r_string_real := STRING_TO_REAL(real_text);
    r_string_hex := STRING_TO_UINT(typed_text);
    r_int_string := INT_TO_STRING(integer);
    r_bool_string := BOOL_TO_STRING(TRUE);
    r_real_cancel := (DINT_TO_REAL(large) + REAL#1.0) - DINT_TO_REAL(large);
    done := cycle >= cycles;
END_IF
END_PROGRAM
