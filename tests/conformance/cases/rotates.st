(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Rotates
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    b : BYTE := BYTE#16#81;
    w : WORD := WORD#16#8001;
    d : DWORD := DWORD#16#80000001;
    width : UINT := 8;
    (* ROL carries the high BYTE bit into its low bit. *)
    r_byte_rol : BYTE;
    (* ROR carries the low BYTE bit into its high bit. *)
    r_byte_ror : BYTE;
    (* ROL by exactly the BYTE width. *)
    r_rol_width : BYTE;
    (* ROR beyond the BYTE width. *)
    r_ror_beyond : BYTE;
    (* ROL beyond the WORD width. *)
    r_word_rol : WORD;
    (* ROR beyond the DWORD width. *)
    r_dword_ror : DWORD;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_byte_rol := ROL(b, 1);
    r_byte_ror := ROR(b, 1);
    r_rol_width := ROL(b, width);
    r_ror_beyond := ROR(b, width + 1);
    r_word_rol := ROL(w, 17);
    r_dword_ror := ROR(d, 33);
    done := cycle >= cycles;
END_IF
END_PROGRAM
