# SPDX-License-Identifier: Apache-2.0

# LuCI app for NijikaWrt. Build inside an OpenWrt tree/SDK with the luci
# feed installed (luci.mk). build.sh does not need this: it copies htdocs/
# and root/ straight into the image.

LUCI_TITLE:=LuCI support for NijikaWrt (stock GUI pages, PON status, OMCI provisioning)
LUCI_DEPENDS:=+luci-base +nijika
LUCI_PKGARCH:=all

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Anime4000

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
