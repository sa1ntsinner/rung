// SPDX-License-Identifier: BUSL-1.1
using System;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Rung.Bridge.Core.Protocol
{
    /// <summary>Shared envelope serialization; independent of engineering sessions.</summary>
    public static class RpcWire
    {
        public static readonly JsonSerializerOptions Json = new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            IncludeFields = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };

        public static string Write(bool hasId, JsonElement id, Action<Utf8JsonWriter> body)
        {
            using (var ms = new MemoryStream())
            {
                using (var w = new Utf8JsonWriter(ms, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }))
                {
                    w.WriteStartObject();
                    w.WritePropertyName("id");
                    if (hasId) id.WriteTo(w); else w.WriteNullValue();
                    body(w);
                    w.WriteEndObject();
                }
                return new UTF8Encoding(false).GetString(ms.ToArray());
            }
        }

        public static string Error(bool hasId, JsonElement id, string code, string message) =>
            Write(hasId, id, w => { w.WritePropertyName("error"); JsonSerializer.Serialize(w, new { code, message = message ?? "" }, Json); });

        public static string Result(bool hasId, JsonElement id, object result) =>
            Write(hasId, id, w => { w.WritePropertyName("result"); JsonSerializer.Serialize(w, result, result?.GetType() ?? typeof(object), Json); });

        public static string Event(string name, object parameters) => JsonSerializer.Serialize(new { @event = name, @params = parameters }, Json);
    }
}
