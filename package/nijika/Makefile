include $(TOPDIR)/rules.mk

PKG_NAME:=nijika
PKG_VERSION:=1
PKG_RELEASE:=1
PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=Anime4000

include $(INCLUDE_DIR)/package.mk

define Package/nijika
  SECTION:=utils
  CATEGORY:=NijikaWrt
  TITLE:=NIJIKA utility: PON/OMCI status, ONT identity, A/B firmware banks
  DEPENDS:=+rtk-vendor +jshn
  PKGARCH:=all
endef

define Package/nijika/description
 `nijika` command line utility for the D-Link DPN-FX3060V: ONT/PON status
 and optical power, OMCI managed entity dumps, PLOAM/serial/LOID, ONT
 identity emulation, ISP VLAN presets, boot bank selection and upgrades.
 PON status is read on demand (5 s cache) by the CLI, LuCI and the banner.
endef

define Build/Compile
endef

define Package/nijika/install
	$(CP) ./files/* $(1)/
endef

$(eval $(call BuildPackage,nijika))
