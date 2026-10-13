include $(TOPDIR)/rules.mk

PKG_NAME:=nijika-base
PKG_VERSION:=1
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=Anime4000

include $(INCLUDE_DIR)/package.mk

define Package/nijika-base
  SECTION:=base
  CATEGORY:=NijikaWrt
  TITLE:=NijikaWrt board support for the D-Link DPN-FX3060V (A1)
  DEPENDS:=+nijika +coreutils-sleep
  PKGARCH:=all
endef

define Package/nijika-base/description
 Board files for NijikaWrt: UBI overlay (rootfs_data) setup in preinit,
 A/B sysupgrade, board identity, default configuration and the animated
 login banner.
endef

define Package/nijika-base/conffiles
/etc/config/nijika
endef

define Build/Compile
endef

define Package/nijika-base/install
	$(CP) ./files/* $(1)/
endef

$(eval $(call BuildPackage,nijika-base))
