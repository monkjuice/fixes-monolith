"""The ``/v1/ws`` realtime layer (protocol §6): live sockets, fan-out and lifecycle hooks.

Everything here is in memory, which is why the server runs as a single process (§2).
"""
