import pytest


@pytest.mark.asyncio
async def test_oauth_store_encrypts_at_rest_and_survives_restart(tmp_path):
    from project_mcp.auth import encrypted_store
    store = encrypted_store(tmp_path, "s" * 40)
    await store.put(key="owner", value={"access_token": "secret-token-for-test"})
    assert all(b"secret-token-for-test" not in file.read_bytes()
               for file in tmp_path.rglob("*") if file.is_file())
    reopened = encrypted_store(tmp_path, "s" * 40)
    assert (await reopened.get(key="owner"))["access_token"] == "secret-token-for-test"
    rotated = encrypted_store(tmp_path, "t" * 40)
    assert await rotated.get(key="owner") is None


@pytest.mark.asyncio
async def test_oauth_store_accepts_url_client_ids_without_path_collisions(tmp_path):
    from project_mcp.auth import encrypted_store

    directory = tmp_path / "oauth"
    store = encrypted_store(directory, "s" * 40)
    keys = ["https://chatgpt.com/oauth/test/client.json", "https://chatgpt.com/oauth/test:client.json",
            "https://chatgpt.com/oauth/test?client.json"]
    collection = "mcp-oauth-proxy-clients"
    for index, key in enumerate(keys):
        assert await store.get(key=key, collection=collection) is None
        await store.put(key=key, collection=collection, value={"client_id": key, "index": index})
    reopened = encrypted_store(directory, "s" * 40)
    for index, key in enumerate(keys):
        assert await reopened.get(key=key, collection=collection) == {"client_id": key, "index": index}
    for file in directory.rglob("*"):
        assert all(char not in file.name for char in ':?')
        if file.is_file():
            assert b"https://chatgpt.com" not in file.read_bytes()
    await reopened.delete(key=keys[0], collection=collection)
    assert await reopened.get(key=keys[0], collection=collection) is None
    assert await reopened.get(key=keys[1], collection=collection) is not None
