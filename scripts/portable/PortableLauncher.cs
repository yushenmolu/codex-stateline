using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CodexStateline.Portable {
    public sealed class PackageFile {
        public string Path;
        public long Length;
        public string Sha256;
    }

    public sealed class PackageManifest {
        public int FormatVersion;
        public string Version, Architecture, NodeVersion, Revision, PayloadSha256;
        public PackageFile[] Files;
    }

    internal static class Program {
        const string PayloadResource = "CodexPortable.Payload";
        const string ManifestResource = "CodexPortable.Manifest";
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

        [STAThread]
        public static int Main(string[] args) {
            string report = null;
            bool verifyOnly = false, selfTest = false;
            try {
                if (args.Length != 0) {
                    if (args.Length != 2 || (args[0] != "--verify" && args[0] != "--self-test"))
                        throw new ArgumentException("Usage: Codex-Stateline.exe [--verify|--self-test <report.json>]");
                    report = Path.GetFullPath(args[1]);
                    verifyOnly = args[0] == "--verify";
                    selfTest = args[0] == "--self-test";
                }
                PackageManifest manifest = ReadManifest();
                string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
                if (String.IsNullOrEmpty(local)) local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (!Path.IsPathRooted(local)) throw new IOException("LOCALAPPDATA must be an absolute path.");
                string cache = Path.Combine(local, "codex-companion", "portable");
                EnsureDirectory(cache);
                string root = Child(cache, manifest.PayloadSha256.Substring(0, 32));
                string identity = WindowsIdentity.GetCurrent().User.Value;
                using (var mutex = new Mutex(false, @"Local\CodexStatelineExtract-" + identity + "-" + manifest.PayloadSha256.Substring(0, 32))) {
                    bool held = false;
                    try {
                        try { held = mutex.WaitOne(TimeSpan.FromMinutes(2)); }
                        catch (AbandonedMutexException) { held = true; }
                        if (!held) throw new IOException("Another launch is still preparing the portable runtime. Please retry.");
                        Prepare(cache, root, manifest);
                    } finally { if (held) mutex.ReleaseMutex(); }
                }
                if (verifyOnly) {
                    WriteReport(report, new { Status = "PASS", Version = manifest.Version, NodeVersion = manifest.NodeVersion,
                        Architecture = manifest.Architecture, CacheRoot = root, Files = manifest.Files.Length, PayloadSha256 = manifest.PayloadSha256 });
                    return 0;
                }
                string script = Path.Combine(root, selfTest ? @"scripts\portable\portable-selftest.ps1" : @"scripts\start-floating-widget.ps1");
                string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe");
                if (!File.Exists(powershell)) throw new IOException("Windows PowerShell 5.1 is required (included with Windows 10/11).");
                var start = new ProcessStartInfo {
                    FileName = powershell,
                    Arguments = "-STA -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(script) +
                        (selfTest ? " -ReportPath " + Quote(report) : ""),
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                // Keep Codex/relay settings, but do not let global Node hooks alter the bundled runtime.
                start.EnvironmentVariables.Remove("NODE_OPTIONS");
                start.EnvironmentVariables.Remove("NODE_PATH");
                using (var process = Process.Start(start)) {
                    process.WaitForExit();
                    if (process.ExitCode != 0) throw new IOException("The widget could not start. See %LOCALAPPDATA%\\codex-companion\\launcher.log.");
                    return 0;
                }
            } catch (Exception error) {
                if (report != null) {
                    // Keep a more specific report emitted by the packaged self-test.
                    if (!File.Exists(report)) try { WriteReport(report, new { Status = "FAIL", Error = error.Message }); } catch { }
                } else {
                    MessageBox.Show(error.Message, "Codex Stateline", MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                return 1;
            }
        }

        static PackageManifest ReadManifest() {
            using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(ManifestResource))
            using (var reader = new StreamReader(source, Encoding.UTF8)) {
                PackageManifest value = Json.Deserialize<PackageManifest>(reader.ReadToEnd());
                if (value == null || value.FormatVersion != 1 || value.Architecture != "x64" ||
                    !Regex.IsMatch(value.PayloadSha256 ?? "", @"\A[0-9a-f]{64}\z") ||
                    !Regex.IsMatch(value.Version ?? "", @"\A\d+\.\d+\.\d+\z") || value.Files == null ||
                    value.Files.Length < 1 || value.Files.Length > 512) throw new IOException("Invalid embedded package manifest.");
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                long total = 0;
                foreach (PackageFile file in value.Files) {
                    ValidateName(file.Path);
                    if (!names.Add(file.Path) || file.Length < 0 || file.Length > 268435456 ||
                        !Regex.IsMatch(file.Sha256 ?? "", @"\A[0-9a-f]{64}\z")) throw new IOException("Invalid package file manifest.");
                    total += file.Length;
                }
                if (total > 536870912 || !names.Contains("runtime/node.exe") || !names.Contains("runtime/NODE-LICENSE.txt") ||
                    !names.Contains("scripts/start-floating-widget.ps1")) throw new IOException("Incomplete portable package.");
                return value;
            }
        }

        static void Prepare(string cache, string root, PackageManifest manifest) {
            if (Directory.Exists(root) && Verify(root, manifest)) return;
            string staging = Child(cache, "preparing-" + Guid.NewGuid().ToString("N"));
            EnsureDirectory(staging);
            try {
                var expected = new Dictionary<string, PackageFile>(StringComparer.OrdinalIgnoreCase);
                foreach (PackageFile file in manifest.Files) expected.Add(file.Path, file);
                using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadResource)) {
                    if (Hash(payload) != manifest.PayloadSha256) throw new IOException("Embedded payload checksum mismatch.");
                    payload.Position = 0;
                    using (var zip = new ZipArchive(payload, ZipArchiveMode.Read, true)) {
                        if (zip.Entries.Count != expected.Count) throw new IOException("Unexpected archive entry count.");
                        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        foreach (ZipArchiveEntry entry in zip.Entries) {
                            PackageFile file;
                            ValidateName(entry.FullName);
                            if (!expected.TryGetValue(entry.FullName, out file) || !seen.Add(entry.FullName) || entry.Length != file.Length)
                                throw new IOException("Unexpected archive entry.");
                            string path = Child(staging, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                            EnsureDirectory(Path.GetDirectoryName(path));
                            using (Stream input = entry.Open())
                            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                                var buffer = new byte[65536];
                                long written = 0;
                                int count;
                                while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
                                    written += count;
                                    if (written > file.Length) throw new IOException("Archive exceeded the declared file size.");
                                    output.Write(buffer, 0, count);
                                }
                                if (written != file.Length) throw new IOException("Incomplete archive entry.");
                            }
                        }
                    }
                }
                if (!Verify(staging, manifest)) throw new IOException("Extracted package checksum mismatch.");
                if (Directory.Exists(root)) {
                    string quarantine = Child(cache, "damaged-" + Guid.NewGuid().ToString("N"));
                    SafeAncestors(root);
                    // Both resolved paths are direct children of this user's cache; never delete a damaged cache.
                    Directory.Move(root, quarantine);
                }
                SafeAncestors(cache);
                Directory.Move(staging, root);
            } finally {
                if (Directory.Exists(staging)) {
                    try {
                        Child(cache, Path.GetFileName(staging));
                        SafeTree(staging);
                        Directory.Delete(staging, true);
                    } catch { /* Retain uncertain paths instead of following a reparse point during cleanup. */ }
                }
            }
        }

        static bool Verify(string root, PackageManifest manifest) {
            SafeAncestors(root);
            var expected = new Dictionary<string, PackageFile>(StringComparer.OrdinalIgnoreCase);
            foreach (PackageFile file in manifest.Files) expected.Add(file.Path, file);
            var actual = new List<string>();
            CollectFiles(root, actual);
            if (actual.Count != expected.Count) return false;
            foreach (string path in actual) {
                string name = path.Substring(root.Length + 1).Replace(Path.DirectorySeparatorChar, '/');
                PackageFile file;
                if (!expected.TryGetValue(name, out file)) return false;
                using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                    if (input.Length != file.Length || Hash(input) != file.Sha256) return false;
                }
            }
            return true;
        }

        static void CollectFiles(string directory, List<string> files) {
            SafeAncestors(directory);
            foreach (string entry in Directory.GetFileSystemEntries(directory)) {
                if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) throw new IOException("A portable cache path is a reparse point.");
                if (Directory.Exists(entry)) CollectFiles(entry, files);
                else files.Add(entry);
            }
        }

        static void SafeTree(string directory) { var files = new List<string>(); CollectFiles(directory, files); }

        static void EnsureDirectory(string directory) {
            SafeAncestors(directory);
            Directory.CreateDirectory(directory);
            SafeAncestors(directory);
        }

        static void SafeAncestors(string path) {
            for (string current = Path.GetFullPath(path); current != null; current = Path.GetDirectoryName(current)) {
                if ((Directory.Exists(current) || File.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new IOException("A portable runtime path is a reparse point. Choose a normal local folder.");
            }
        }

        internal static string Child(string parent, string relative) {
            string root = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string path = Path.GetFullPath(Path.Combine(root, relative));
            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase) || path.Length == root.Length)
                throw new IOException("A package path escapes its cache directory.");
            return path;
        }

        internal static void ValidateName(string name) {
            if (String.IsNullOrEmpty(name) || name.Length > 200 || name.IndexOfAny(new[] { '\\', ':', '*', '?', '"', '<', '>', '|' }) >= 0 || name.StartsWith("/"))
                throw new IOException("Invalid package path.");
            foreach (string part in name.Split('/')) {
                if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
                    part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 ||
                    Regex.IsMatch(part, @"\A(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|\z)", RegexOptions.IgnoreCase))
                    throw new IOException("Invalid package path segment.");
            }
        }

        static string Hash(Stream stream) {
            using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        }

        internal static string Quote(string value) {
            var result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
                else result.Append('\\', slashes).Append(c);
                slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }

        static void WriteReport(string path, object value) {
            File.WriteAllText(path, Json.Serialize(value), new UTF8Encoding(false));
        }
    }
}
