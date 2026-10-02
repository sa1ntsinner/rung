(* SPDX-License-Identifier: MIT *)
FUNCTION_BLOCK FB_ConformanceAccumulate
VAR_INPUT
    increment : INT;
END_VAR
VAR_OUTPUT
    total : INT;
END_VAR
total := total + increment;
END_FUNCTION_BLOCK
