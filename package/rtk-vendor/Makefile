include $(TOPDIR)/rules.mk

PKG_NAME:=rtk-vendor
PKG_VERSION:=1
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=Anime4000

include $(INCLUDE_DIR)/package.mk

define Package/rtk-vendor
  SECTION:=utils
  CATEGORY:=NijikaWrt
  TITLE:=Stock Realtek userland integration (/rtk chroot, boa shim)
  PKGARCH:=all
endef

define Package/rtk-vendor/description
 Starts the stock Realtek userland of the D-Link DPN-FX3060V inside the
 /rtk chroot (PON, OMCI, WAN, WiFi, VoIP), provides the boa shim and
 wrappers for the stock tools (mib, flash, diag, omcicli, nv, ...).
 The /rtk tree itself comes from the stock firmware (see build.sh).
endef

define Build/Compile
endef

define Package/rtk-vendor/install
	$(CP) ./files/* $(1)/
	$(INSTALL_DIR) $(1)/usr/bin $(1)/usr/sbin
	for t in mib flash diag omcicli nv voipflashcmd smuxctl spppctl; do \
		$(LN) ../libexec/rtk/wrap $(1)/usr/bin/$$$$t; \
	done
	$(LN) ../libexec/rtk/run $(1)/usr/sbin/rtk
endef

$(eval $(call BuildPackage,rtk-vendor))
