(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Unsigned
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    usint_max : USINT := 255;
    usint_zero : USINT;
    uint_max : UINT := 65535;
    uint_zero : UINT;
    udint_max : UDINT := 4294967295;
    udint_zero : UDINT;
    small : UINT := 65000;
    wide : UDINT := 100000;
    (* USINT maximum plus one wraps to zero. *)
    r_usint_overflow : USINT;
    (* USINT zero minus one wraps to the maximum. *)
    r_usint_underflow : USINT;
    (* USINT multiplication wraps at its width. *)
    r_usint_mul : USINT;
    (* UINT maximum plus one wraps to zero. *)
    r_uint_overflow : UINT;
    (* UINT zero minus one wraps to the maximum. *)
    r_uint_underflow : UINT;
    (* UINT multiplication wraps at its width. *)
    r_uint_mul : UINT;
    (* UDINT maximum plus one wraps to zero. *)
    r_udint_overflow : UDINT;
    (* UDINT zero minus one wraps to the maximum. *)
    r_udint_underflow : UDINT;
    (* UDINT multiplication wraps at its width. *)
    r_udint_mul : UDINT;
    (* UINT and UDINT arithmetic widens before assignment. *)
    r_mixed_widen : UDINT;
    (* A UINT sum assigned to UDINT exposes native intermediate width. *)
    r_intermediate : UDINT;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_usint_overflow := usint_max + USINT#1;
    r_usint_underflow := usint_zero - USINT#1;
    r_usint_mul := usint_max * USINT#2;
    r_uint_overflow := uint_max + UINT#1;
    r_uint_underflow := uint_zero - UINT#1;
    r_uint_mul := uint_max * UINT#2;
    r_udint_overflow := udint_max + UDINT#1;
    r_udint_underflow := udint_zero - UDINT#1;
    r_udint_mul := udint_max * UDINT#2;
    r_mixed_widen := small + wide;
    r_intermediate := uint_max + UINT#1;
    done := cycle >= cycles;
END_IF
END_PROGRAM
