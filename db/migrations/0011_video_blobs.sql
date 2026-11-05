-- Videos indexed before 0010 were filed as 'other'; the worker files new ones as 'video'.
update blobs set file_kind = 'video' where file_kind = 'other' and mime like 'video/%';
