# Recovery

NijikaWrt never touches the bootloader, the U-Boot environment layout,
`ubi_Config` (stock settings) or the bank it is not installed to. A bad image
can therefore always be undone by booting the other bank.

## Before the first flash

* Connect the UART (ttyS0, 115200 8N1) and keep a terminal logging.
* Check which bank runs stock: `nv getenv` → `sw_commit`, `sw_version0/1`.
  On the factory unit both banks contain `DPN-FX3060V_V1.1.2` and bank 1 is
  committed, so flashing writes NijikaWrt to **bank 0**.
* Optional but recommended: back up the UBI volumes of both banks and
  `ubi_Config`, e.g. with `cat /dev/ubi0_0 | nc <pc> 9999` or the NIJIKA
  `send_mtd` approach.

## NijikaWrt boots but something is wrong

* `nijika boot <other bank>` then `reboot` returns to stock.
* Or write stock firmware to the other bank: `nijika upgrade
  DPN-FX3060V_….bin` or `sysupgrade -F -n DPN-FX3060V_….bin` (forced, since a
  stock image has no board metadata).
* `logread -e rtk`, `cat /tmp/log/rtk-boot.log`: vendor stack messages.
* `rtk` opens a stock shell inside the chroot (stock `mib`, `diag`, … as usual).
* `uci set nijika.vendor.boa=stock; uci commit; reload_config` gives the
  D-Link GUI on `http://192.168.0.1:8080/`.
* OpenWrt failsafe: press `f` + Enter on the console when preinit prompts.
  This boots without the overlay; `firstboot -y` resets OpenWrt settings only.

## Lost the LuCI/SSH password

Like OpenWrt, NijikaWrt starts with an empty root password; the stock D-Link
passwords do not apply to LuCI or SSH.

* Serial console: press Enter for a root shell (no login), then
  `passwd -d root` (back to no password) or `passwd` (new password).
* Or OpenWrt failsafe: press `f` + Enter when preinit prompts, then
  `firstboot -y && reboot` (resets all OpenWrt settings, keeps the stock MIB).
* Or flash a `-factory.bin` from the stock GUI: a factory install resets the
  OpenWrt overlay.

## NijikaWrt does not boot (or no console)

A trial boot (default for `nijika upgrade`/sysupgrade) falls back on its own:
U-Boot armed a 60 s watchdog, and if the kernel/procd never comes up the
board resets into `sw_commit`.

If NijikaWrt was committed (`--commit`, or the stock web upgrade committed it),
interrupt U-Boot ("Hit any key to stop autoboot") on the console:

```
setenv sw_commit 1
setenv sw_active 1
setenv sw_tryactive 2
saveenv
reset
```

(use the bank number that still holds stock firmware).

## Stock GUI upgrade fails with "ubiupdatevol … Device or resource busy"

The stock GUI writes bank `1 - sw_active`. If a bank was booted by hand from
U-Boot (`run b1`/`run b2`) without `saveenv`, `sw_active` no longer matches the
running bank, and the GUI targets the firmware that is running right now.
NijikaWrt's `fwu.sh` detects this, writes nothing, corrects the environment
(`sw_active=sw_commit=<running bank>`, `sw_tryactive=2`) and prints
`[x] please upload the firmware again`. Uploading again then writes the other
bank and trial-boots it.

The installer logs every step on the serial console with tags: `[~]` in
progress, `[+]` ok, `[-]` skipped, `[!]` warning, `[x]` failed, `[?]` unknown.
A failure before `[~] writing …` means nothing was flashed.
`/var/firmware_upgrade_status` is set like stock: 1 = invalid image, 3 = too
big for the volume.

## Re-flashing a bank from U-Boot

The stock environment ships TFTP helpers (server `serverip=192.168.1.7`,
board `ipaddr=192.168.1.2`):

```
setenv serverip <pc-ip>; setenv ipaddr <board-ip>
run upk1     # tftp Image.lzma -> ubi_k1      (bank 1 kernel)
run upr1     # tftp rootfs     -> ubi_r1      (bank 1 rootfs)
run upd1     # tftp dtb.img    -> ubi_DTB1
```

Take `kimage` (rename to `Image.lzma`), `rootfs` and `dtb` (rename to
`dtb.img`) from the stock firmware tar. **Do not** use `updev`/`upb`/`upenv`:
they rewrite the whole UBI device, the bootloader or the environment.

## Removing NijikaWrt leftovers

Stock firmware ignores the extra UBI volume. To reclaim the space from a
stock shell: `ubirmvol /dev/ubi0 -N rootfs_data`.
