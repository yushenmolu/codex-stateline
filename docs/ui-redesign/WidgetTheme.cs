// ---------------------------------------------------------------------------
// WidgetTheme.cs - design tokens for the native widget.
// Values are identical to src/public/tokens.css (dark theme).  Nothing here
// changes behaviour: it is a constants file.  To adopt it, append this path to
// the Add-Type file list in scripts/native-widget.ps1 (see the redesign report,
// section 6.1) and then replace literals in WidgetClient.cs one cluster at a
// time, starting with the dialog/popup shells.
// ---------------------------------------------------------------------------
using System.Windows;
using System.Windows.Media;

namespace CodexNative
{
    internal static class WidgetTheme
    {
        // Surfaces
        public const string Page = "#141518";
        public const string Card = "#1C1D21";
        public const string Raised = "#24252A";
        public const string Inset = "#0E0F11";
        public const string Hover = "#2D2E34";
        public const string Active = "#373941";
        public const string Inverse = "#EDEEF2";

        // Borders
        public const string BorderSubtle = "#373941";
        public const string BorderDefault = "#3F414B";
        public const string BorderStrong = "#6F7485";

        // Text
        public const string Text1 = "#EDEEF2";
        public const string Text2 = "#B0B3BF";
        public const string Text3 = "#9A9EAC";
        public const string TextDisabled = "#636674";
        public const string TextOnAccent = "#FFFFFF";
        public const string TextOnInverse = "#141518";

        // Accent
        public const string Accent = "#8593FF";
        public const string AccentHover = "#B2BBFF";
        public const string AccentActive = "#D6DBFF";
        public const string AccentSubtle = "#2B2E40";
        public const string AccentFill = "#4A5AD6";
        public const string AccentFillHover = "#5869E4";
        public const string AccentFillActive = "#394AD0";
        public const string AccentOnFill = "#FFFFFF";

        // Status
        public const string Success = "#69D3A2";
        public const string SuccessSubtle = "#273633";
        public const string Warning = "#F8B659";
        public const string WarningSubtle = "#3B3229";
        public const string Danger = "#FA8088";
        public const string DangerSubtle = "#3B2B2F";

        // Data
        public const string Data1 = "#8F9CFF";
        public const string Data2 = "#49D4C6";
        public const string Data3 = "#C08DE2";
        public const string ChartGrid = "#373941";
        public const string ChartTrack = "#24252A";

        // Focus
        public const string FocusRing = "#8593FF";
        public const string FocusRingOffset = "#141518";

        // Type scale (px)
        public const double Text2Xs = 11;
        public const double TextXs = 12;
        public const double TextSm = 13;
        public const double TextMd = 15;
        public const double TextLg = 17;
        public const double TextXl = 22;
        public const double Text2Xl = 28;

        // Spacing (4 px grid)
        public const double Space1 = 2;
        public const double Space2 = 4;
        public const double Space3 = 6;
        public const double Space4 = 8;
        public const double Space5 = 12;
        public const double Space6 = 16;
        public const double Space7 = 20;
        public const double Space8 = 24;
        public const double Space9 = 32;

        // Radius
        public const double RadiusXs = 3;
        public const double RadiusSm = 6;
        public const double RadiusMd = 10;
        public const double RadiusLg = 14;

        // Control heights
        public const double ControlSm = 24;
        public const double Control = 30;
        public const double ControlLg = 34;
        public const double FocusRingWidth = 2;

        public static readonly FontFamily UiFont =
            new FontFamily("Segoe UI, Microsoft YaHei UI, Microsoft YaHei");

        // Common paddings, pre-built so call sites stay short.
        public static readonly Thickness CardPadding = new Thickness(12, 10, 12, 10);
        public static readonly Thickness ControlPadding = new Thickness(8, 0, 8, 0);
        public static readonly Thickness LabelGap = new Thickness(0, 0, 0, 2);
        public static readonly Thickness SectionGap = new Thickness(0, 0, 0, 8);

        // ------------------------------------------------------------ helpers
        // Brushes and pens are frozen and cached so hot paths (bindings,
        // re-renders) do not allocate a new Brush per call.  WidgetClient.cs
        // already has its own private B(string); these are the replacements
        // once literals are migrated.
        private static readonly System.Collections.Generic.Dictionary<string, SolidColorBrush> _brushCache
            = new System.Collections.Generic.Dictionary<string, SolidColorBrush>();

        private static readonly System.Collections.Generic.Dictionary<string, Pen> _penCache
            = new System.Collections.Generic.Dictionary<string, Pen>();

        /// <summary>Frozen, cached brush for a "#RRGGBB" literal.</summary>
        public static SolidColorBrush Brush(string hex)
        {
            if (string.IsNullOrEmpty(hex)) return null;
            SolidColorBrush cached;
            if (_brushCache.TryGetValue(hex, out cached)) return cached;
            Color color = (Color)ColorConverter.ConvertFromString(hex);
            SolidColorBrush brush = new SolidColorBrush(color);
            brush.Freeze();
            _brushCache[hex] = brush;
            return brush;
        }

        /// <summary>Frozen, cached 1px (device-independent) pen.</summary>
        public static Pen Pen1(string hex)
        {
            return Pen1(hex, 1.0);
        }

        /// <summary>Frozen, cached pen of the given thickness.</summary>
        public static Pen Pen1(string hex, double thickness)
        {
            string key = hex + "@" + thickness.ToString(System.Globalization.CultureInfo.InvariantCulture);
            Pen cached;
            if (_penCache.TryGetValue(key, out cached)) return cached;
            Pen pen = new Pen(Brush(hex), thickness);
            pen.Freeze();
            _penCache[key] = pen;
            return pen;
        }

        /// <summary>Shadow matching the CSS --shadow-N tokens (dark theme).</summary>
        public static System.Windows.Media.Effects.DropShadowEffect Shadow(int level)
        {
            double[] blur = { 0, 12, 24, 40 };
            double[] opacity = { 0, 0.45, 0.55, 0.70 };
            int i = level < 0 ? 0 : (level > 3 ? 3 : level);
            if (i == 0) return null;
            return new System.Windows.Media.Effects.DropShadowEffect
            {
                Color = Colors.Black,
                ShadowDepth = 0,
                Direction = 270,
                BlurRadius = blur[i],
                Opacity = opacity[i],
                RenderingBias = System.Windows.Media.Effects.RenderingBias.Performance
            };
        }
    }
}
