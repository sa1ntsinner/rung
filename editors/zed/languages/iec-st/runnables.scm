; SPDX-License-Identifier: MIT
; A run button next to every POU header: test it on rung's offline simulator (tasks tagged rung-block).
((function_block name: (_) @run) (#set! tag rung-block))
((function name: (_) @run) (#set! tag rung-block))
((program name: (_) @run) (#set! tag rung-block))
