// SPDX-License-Identifier: MIT
import {expectTypeOf,it} from "vitest";
import type {TraceRecording} from "../../../packages/live/src/trace";
import type {TraceCsvView} from "../../../packages/live/src/traceCsv";
import type {SubscriptionTraceModel,TraceCsvModel} from "../src/core/trace";
it("keeps the editor trace model identical to the portable recording",()=>{expectTypeOf<SubscriptionTraceModel>().toEqualTypeOf<TraceRecording>();expectTypeOf<TraceCsvModel>().toEqualTypeOf<TraceCsvView>();});
