(* SPDX-License-Identifier: MIT *)
PROGRAM PRG_Bits
VAR CONSTANT
    cycles : UINT := 1;
END_VAR
VAR
    cycle : UINT;
    done : BOOL;
    b : BYTE := BYTE#16#81;
    w : WORD := WORD#16#8001;
    d : DWORD := DWORD#16#80000001;
    shift8 : UINT := 8;
    shift16 : UINT := 16;
    shift32 : UINT := 32;
    access : WORD := WORD#16#0008;
    (* SHL truncates a BYTE. *)
    r_byte_shl : BYTE;
    (* SHR shifts a BYTE logically. *)
    r_byte_shr : BYTE;
    (* SHL at the BYTE width. *)
    r_byte_width : BYTE;
    (* SHR beyond the BYTE width. *)
    r_byte_beyond : BYTE;
    (* SHL at the WORD width. *)
    r_word_width : WORD;
    (* SHR beyond the WORD width. *)
    r_word_beyond : WORD;
    (* SHL at the DWORD width exposes target-dependent shift counts. *)
    r_dword_width : DWORD;
    (* SHR beyond the DWORD width exposes target-dependent shift counts. *)
    r_dword_beyond : DWORD;
    (* WORD AND keeps only the low byte. *)
    r_and : WORD;
    (* WORD OR sets low bits. *)
    r_or : WORD;
    (* DWORD XOR complements all bits. *)
    r_xor : DWORD;
    (* DWORD NOT preserves unsigned width. *)
    r_not : DWORD;
    (* CODESYS bit access reads bit three. *)
    r_bit_read : BOOL;
    (* Bit assignment changes only the selected bit. *)
    r_bit_write : WORD;
END_VAR
IF NOT done THEN
    cycle := cycle + 1;
    r_byte_shl := SHL(b, 1);
    r_byte_shr := SHR(b, 1);
    r_byte_width := SHL(b, shift8);
    r_byte_beyond := SHR(b, shift8 + 1);
    r_word_width := SHL(w, shift16);
    r_word_beyond := SHR(w, shift16 + 1);
    r_dword_width := SHL(d, shift32);
    r_dword_beyond := SHR(d, shift32 + 1);
    r_and := w AND WORD#16#00FF;
    r_or := w OR WORD#16#00F0;
    r_xor := d XOR DWORD#16#FFFFFFFF;
    r_not := NOT d;
    r_bit_read := access.3;
    access.3 := FALSE;
    access.7 := TRUE;
    r_bit_write := access;
    done := cycle >= cycles;
END_IF
END_PROGRAM
