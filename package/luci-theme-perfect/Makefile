# Perfect LuCI theme for NijikaWrt (perfect.my colours over Bootstrap). Build
# inside an OpenWrt tree/SDK with the luci feed installed (luci.mk).
# build.sh does not need this: it copies htdocs/ and root/ straight into the
# image.

LUCI_TITLE:=Perfect theme (perfect.my colours, based on Bootstrap)
LUCI_DEPENDS:=+luci-theme-bootstrap
LUCI_PKGARCH:=all

PKG_LICENSE:=Apache-2.0 OFL-1.1
PKG_MAINTAINER:=Anime4000

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
