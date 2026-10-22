using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace CodexNative {
    /// <summary>
    /// A single notification-area icon. This is what keeps the widget usable
    /// while the main window is hidden: the widget owns no taskbar button, so
    /// the tray icon is the only entry point back to the panel.
    /// </summary>
    internal sealed class TrayIcon : IDisposable {
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        static extern bool DestroyIcon(IntPtr handle);

        static readonly Color Accent = Color.FromArgb(255, 74, 90, 214);
        static readonly Color Surface = Color.FromArgb(255, 20, 21, 24);
        static readonly Color Ink = Color.FromArgb(255, 237, 238, 242);

        readonly NotifyIcon icon;
        readonly ToolStripMenuItem headline;
        readonly ToolStripMenuItem detail;
        readonly ToolStripMenuItem showItem;
        readonly ToolStripMenuItem usageItem;
        readonly ToolStripMenuItem resultsItem;
        readonly ToolStripMenuItem exitItem;
        Icon current;
        bool disposed;

        public TrayIcon(string title, Action show, Action openUsage, Action openResults, Action exit) {
            headline = new ToolStripMenuItem(Safe(title)) { Enabled = false };
            detail = new ToolStripMenuItem(String.Empty) { Enabled = false, Visible = false };
            showItem = new ToolStripMenuItem("显示面板");
            usageItem = new ToolStripMenuItem("用量统计");
            resultsItem = new ToolStripMenuItem("测试 / 作品结果");
            exitItem = new ToolStripMenuItem("退出");
            // A missing callback must not produce a menu entry that silently does nothing.
            if (show != null) { showItem.Click += delegate { show(); }; } else { showItem.Enabled = false; }
            if (openUsage != null) { usageItem.Click += delegate { openUsage(); }; } else { usageItem.Enabled = false; }
            if (openResults != null) { resultsItem.Click += delegate { openResults(); }; } else { resultsItem.Enabled = false; }
            if (exit != null) { exitItem.Click += delegate { exit(); }; }

            var menu = new ContextMenuStrip();
            menu.Items.Add(headline);
            menu.Items.Add(detail);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(showItem);
            menu.Items.Add(usageItem);
            menu.Items.Add(resultsItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exitItem);

            current = CreateIcon(Accent, Surface, Ink);
            icon = new NotifyIcon();
            icon.Icon = current;
            icon.Text = Safe(title);
            icon.ContextMenuStrip = menu;
            icon.Visible = true;
            if (show != null) icon.DoubleClick += delegate { show(); };
        }

        /// <summary>Refreshes the hover text and the disabled menu headline.</summary>
        public void SetStatus(string title, string detailText) {
            if (disposed) return;
            try {
                headline.Text = Safe(title);
                icon.Text = Safe(title);
                bool hasDetail = !String.IsNullOrEmpty(detailText);
                detail.Text = hasDetail ? Safe(detailText) : String.Empty;
                detail.Visible = hasDetail;
            } catch { /* A tray refresh must never break the panel. */ }
        }

        static Icon CreateIcon(Color tone, Color surface, Color ink) {
            using (var bitmap = new Bitmap(32, 32, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.SmoothingMode = SmoothingMode.AntiAlias;
                graphics.Clear(Color.Transparent);
                using (var path = RoundedRect(new RectangleF(1f, 1f, 30f, 30f), 9f))
                using (var fill = new SolidBrush(surface))
                using (var border = new Pen(tone, 2f))
                using (var bar = new SolidBrush(ink)) {
                    graphics.FillPath(fill, path);
                    graphics.DrawPath(border, path);
                    // Two short bars read as a status panel even when scaled to 16 px.
                    graphics.FillRectangle(bar, 8f, 11f, 16f, 3.2f);
                    graphics.FillRectangle(bar, 8f, 17.5f, 10f, 3.2f);
                }
                return FromBitmap(bitmap);
            }
        }

        static GraphicsPath RoundedRect(RectangleF bounds, float radius) {
            float diameter = radius * 2f;
            var path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, diameter, diameter, 180f, 90f);
            path.AddArc(bounds.Right - diameter, bounds.Y, diameter, diameter, 270f, 90f);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0f, 90f);
            path.AddArc(bounds.X, bounds.Bottom - diameter, diameter, diameter, 90f, 90f);
            path.CloseFigure();
            return path;
        }

        static Icon FromBitmap(Bitmap bitmap) {
            IntPtr handle = bitmap.GetHicon();
            try {
                using (Icon copy = Icon.FromHandle(handle)) {
                    // Clone so the returned icon owns its own data after the HICON is released.
                    return (Icon)copy.Clone();
                }
            } finally {
                DestroyIcon(handle);
            }
        }

        static string Safe(string value) {
            if (String.IsNullOrEmpty(value)) return "Codex 状态";
            string text = value.Replace("\r", " ").Replace("\n", " ").Trim();
            // NotifyIcon.Text is capped by the shell; keep well inside the limit.
            return text.Length <= 120 ? text : text.Substring(0, 119) + "…";
        }

        public void Dispose() {
            if (disposed) return;
            disposed = true;
            try { icon.Visible = false; } catch { }
            try { icon.Dispose(); } catch { }
            if (current != null) {
                try { current.Dispose(); } catch { }
                current = null;
            }
        }
    }
}
