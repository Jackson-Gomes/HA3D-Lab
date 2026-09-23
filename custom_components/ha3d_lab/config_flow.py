from __future__ import annotations

import probatio

from homeassistant import config_entries

from .const import DOMAIN


class HA3DConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure HA3D from the Home Assistant UI."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is not None:
            return self.async_create_entry(title="HA3D Lab", data={})

        return self.async_show_form(step_id="user", data_schema=probatio.Schema({}))
