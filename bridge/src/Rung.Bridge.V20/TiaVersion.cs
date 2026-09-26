// SPDX-License-Identifier: BUSL-1.1
namespace Rung.Bridge.V20
{
    static class TiaVersion
    {
#if TIA_V21
        public const string Name = "V21";
#else
        public const string Name = "V20";
#endif
    }
}
