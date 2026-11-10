"""SDK-facing alias kept alongside the 7invensun driver implementation.

Keep both legacy script imports and package imports working. Alias the module
rather than copying exports so dependency patching and class identity remain
consistent with the implementation for each launch mode.
"""

import sys

from . import driver as _implementation

sys.modules[__name__] = _implementation
