(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Int64
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    signed_high : LINT := LINT#4611686018427387904;
    unsigned_high : ULINT := ULINT#9223372036854775808;
    signed_min : LINT := LINT#-9223372036854775808;
    scratch : ULINT;
    (* A sum crossing the signed 64-bit boundary wraps. *)
    r_lint_overflow : LINT;
    (* Multiplication crossing the signed 64-bit boundary wraps. *)
    r_lint_mul : LINT;
    (* Negative LINT division preserves all 64 bits. *)
    r_lint_div : LINT;
    (* A sum crossing the unsigned 64-bit boundary wraps. *)
    r_ulint_overflow : ULINT;
    (* Multiplication crossing the unsigned 64-bit boundary wraps. *)
    r_ulint_mul : ULINT;
    (* Low bits of ULINT zero minus one; the full maximum is not a JavaScript integer. *)
    r_ulint_underflow_low : BYTE;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_lint_overflow := signed_high + signed_high;
    r_lint_mul := signed_high * LINT#2;
    r_lint_div := signed_min / LINT#2;
    r_ulint_overflow := unsigned_high + unsigned_high;
    r_ulint_mul := unsigned_high * ULINT#2;
    scratch := ULINT#0;
    scratch := scratch - ULINT#1;
    r_ulint_underflow_low := ULINT_TO_BYTE(scratch);
    done := cycle >= cycles;
END_IF
END_PROGRAM
