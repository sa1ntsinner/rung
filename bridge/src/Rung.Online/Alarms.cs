// SPDX-License-Identifier: BUSL-1.1
using System.Globalization;
using Rung.Bridge.Core.Protocol;
using S7CommPlusDriver.Alarming;

namespace Rung.Online;

public sealed record OnlineAlarm(string Id, uint SourceRelationId, ushort SourceAlarmId, ushort Domain, int MessageType,
    byte RawStates, uint Sequence, bool Active, string? CpuTimestamp, long ReceivedAt, int RequestedLcid, int? TextLcid, string Text);
public static class Alarms
{
    public static OnlineAlarm Normalize(S7CommPlusAlarm alarm, int lcid, long receivedAt) {
        var texts = alarm.AlarmTextsByLanguage.TryGetValue(lcid, out var selected) && !string.IsNullOrEmpty(selected.AlarmText) ? selected
            : alarm.AlarmTextsByLanguage.OrderBy(p => p.Key).Select(p => p.Value).FirstOrDefault(t => !string.IsNullOrEmpty(t.AlarmText)) ?? alarm.AlarmTexts;
        var text = string.IsNullOrEmpty(texts?.AlarmText) ? $"Alarm {alarm.CpuAlarmId}" : texts.AlarmText;
        return new(alarm.CpuAlarmId.ToString(CultureInfo.InvariantCulture), alarm.SourceRelationId, alarm.SourceAlarmId, alarm.AlarmDomain, alarm.MessageType,
            alarm.AllStatesInfo, alarm.SequenceCounter, alarm.StateChange?.SubtypeId != (uint)S7CommPlusAlarmStateChange.SubtypeIds.Going,
            alarm.StateChange?.Timestamp.ToString("O", CultureInfo.InvariantCulture), receivedAt, lcid, texts?.LanguageId, text);
    }
}
public sealed class AlarmSet
{
    readonly Dictionary<string, OnlineAlarm> rows = new(StringComparer.Ordinal);
    public OnlineAlarm[] Snapshot => rows.Values.OrderBy(r => r.Id, StringComparer.Ordinal).ToArray();
    public void Merge(OnlineAlarm[] update) {
        foreach (var row in update) {
            if (rows.TryGetValue(row.Id, out var old)) {
                var delta = unchecked(row.Sequence - old.Sequence);
                if (delta >= 0x80000000) continue;
                // Coming and Going share an occurrence counter on the PLC.
                // CPU time orders those changes; receive time cannot order an older snapshot.
                if (delta == 0 && (!DateTimeOffset.TryParse(row.CpuTimestamp, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var nextTime)
                    || !DateTimeOffset.TryParse(old.CpuTimestamp, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var oldTime)
                    || nextTime <= oldTime)) continue;
            } else if (rows.Count >= 4096) throw new RpcException(ErrorCodes.ResourceLimit, "Alarm snapshot exceeds 4096 IDs.");
            rows[row.Id] = row;
        }
    }
    public void Clear() => rows.Clear();
}
